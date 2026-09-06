'use client'

// Milestone M4: the launch panel (M4-UI-MATCH restyle), M10: native
// pump.fun program.
//
// Form: token name / symbol / metadata URI (direct entry; see the
// Arweave/IPFS decision comment below), the connected creator key (the
// SAME wallet the masthead connects via pumpfun.creatorKey.v1), the
// selected dev wallets with a per-wallet sol_in, and a Launch button that
// drives lib/bundle:
//
//   Tier 1 (default): buildLaunchSequence + preflightLaunch +
//                     sendSequentially as normal devnet txs.
//   Tier 2:           the same sequence assembled into a Jito bundle
//                     (JitoBundleClient.assembleBundle + simulateBundle +
//                     submitWithRetry). Devnet reality: the devnet block
//                     engine host does not resolve, so submission cannot
//                     land; the panel reports that honestly after proving
//                     the construction.
//
// M10 (native pump.fun): the launch talks to pump.fun's OWN program
// (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P), so every token launched is
// a real pump.fun token: indexed everywhere with the `.pump` suffix (the
// suffix is indexer-applied; the symbol is passed PLAIN). The create args
// are ONLY name/symbol/uri — the old M3 capability gate (auto_migrate /
// lock_lp create args on the CUSTOM program) is GONE: pump.fun
// auto-migrates its curves to PumpSwap on graduation, so the launch panel
// no longer carries migration toggles and no anchor Program/IDL exists
// anymore (every instruction is hand-built in lib/pump.ts; the mint is a
// fresh Keypair generated at sequence build time).
//
// METADATA (M9: structured + publish-on-launch):
// The single URI input is replaced by discrete description / image /
// social fields. On launch the client posts the fields to the same-origin
// /api/metadata/publish route, which uploads the composed pump.fun-style
// JSON (and the image file when one was picked) to the configured backend
// and returns the on-chain uri. Backend = VPS (preferred,
// tools/metadata-vps/server.mjs) or IPFS via Pinata; server env, see
// lib/metadata-publish.ts + .env.local.example. The image lives INSIDE the
// JSON (standard `image` field), so the stored uri is just the
// metadata.json URL. A "manual metadata uri" toggle in Advanced keeps the
// old direct-URI flow (devnet quick launches / no backend configured). The
// create() arg is still a plain <=200-byte string stored verbatim in the
// mpl metadata account.
//
// M4-UI-MATCH: the layout now mirrors v4-launchpad's Launch card (Card +
// Field + Input + Collapse primitives, "Launch" card head). The status log
// and ALL M4 launch logic are preserved unchanged.

import {
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
} from '@solana/web3.js'
import bs58 from 'bs58'
import { useCallback, useMemo, useState } from 'react'
import {
    ataRentLamports,
    buildLaunchSequence,
    ensurePumpLookupTable,
    holderCount,
    postBuyFloorLamports,
    preflightLaunch,
    readToken2022Metadata,
    sendSequentially,
    simulateBundle,
    walletTokenBalance,
    withTimeout,
    type BuyAllocation,
} from '../lib/bundle'
import { publishTokenMetadata } from '../lib/metadata'
import {
    JITO_MAINNET_ENDPOINT,
    JitoBundleClient,
    KNOWN_TIP_ACCOUNTS,
    MIN_TIP_LAMPORTS,
    type BundleSubmissionResult,
} from '../lib/bundle/jito'
import { DEFAULT_JITO_TIP_LAMPORTS } from '../lib/fees'
import { submitBundleViaFanoutWithRetry } from '../lib/bundle/fanout-submit'
import { bundleDropMessage, friendlyTxError } from '../lib/tx-errors'
import { makeAppConnection } from '../lib/connection'
import { solanaNetwork } from '../lib/network'
import { useCreatorWallet } from '../lib/creator-wallet'
import { pubkeyFromSecretKey } from '../lib/managed-wallets'
import { DECIMALS } from '../lib/params'
import { readPumpCurveState } from '../lib/pump'
import {
    formatSolLamports,
    sellAllManagedWallets,
    type SellAllReport,
    type SellOutcome,
} from '../lib/sell-all'
import { useToasts } from './toast-stack'
import {
    Btn,
    Card,
    Collapse,
    ExplorerLink,
    Field,
    Input,
    StatusLine,
} from './ui'
import type { RosterApi } from './roster'
import { shortAddress } from './roster'

const EXPLORER = 'https://explorer.solana.com'
/** Explorer cluster query: devnet links need ?cluster=devnet; mainnet none. */
const EXPLORER_QS = solanaNetwork() === 'devnet' ? '?cluster=devnet' : ''
const DEFAULT_SOL_IN = '0.01'
/** Default Jito bundle tip (Tier 2) shown in the tip field, in SOL.
 *  Matches lib/fees DEFAULT_JITO_TIP_LAMPORTS (0.001 SOL). */
const DEFAULT_TIP_SOL = (DEFAULT_JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL).toString()

function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message
    return String(e)
}

/** Token amount formatter (trade panel's helper moved with Sell All): raw
 *  base units -> a 4-decimal display string using the program's decimals. */
function fmtTokens(raw: bigint): string {
    return `${(Number(raw) / 10 ** DECIMALS).toFixed(4)}`
}

export function LaunchPanel({
    roster,
    onLaunched,
    mint,
}: {
    roster: RosterApi
    /** Called with the mint after a successful launch (pre-fills the trade
     *  panel's token-address input, mirroring v4's LAUNCH -> trade flow). */
    onLaunched?: (mint: string) => void
    /** The mint the Trade panel tracks (a launch pre-fills it). Drives the
     *  Sell All button below the Launch button; null disables it. */
    mint?: string | null
}) {
    const {
        key: creatorKey,
        pubkey: creatorPubkey,
        connected,
        balanceSol,
    } = useCreatorWallet()
    const { pushToast } = useToasts()

    const [name, setName] = useState('M4 UI Launch')
    const [symbol, setSymbol] = useState('M4UI')
    const [uri, setUri] = useState('https://example.com/m4-ui-launch.json')
    // M9 structured metadata: description / image / socials are
    // auto-published to the configured backend on launch and the returned
    // URL becomes the create() uri. manualMetadata keeps the old single-URI
    // flow (devnet quick launches / no backend configured).
    const [description, setDescription] = useState('')
    const [imageFile, setImageFile] = useState<File | null>(null)
    const [website, setWebsite] = useState('')
    const [twitter, setTwitter] = useState('')
    const [telegram, setTelegram] = useState('')
    const [manualMetadata, setManualMetadata] = useState(false)
    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [tier, setTier] = useState<'1' | '2'>('2')
    const [fundFromCreator, setFundFromCreator] = useState(true)
    const [tipSol, setTipSol] = useState(DEFAULT_TIP_SOL)
    const [solIns, setSolIns] = useState<Record<string, string>>({})
    const [busy, setBusy] = useState(false)
    const [statusLines, setStatusLines] = useState<string[]>([])
    const [launchError, setLaunchError] = useState<string | null>(null)
    const [lastMint, setLastMint] = useState<string | null>(null)

    const selectedWallets = useMemo(
        () => roster.wallets.filter((w) => roster.checked.has(w.address)),
        [roster.wallets, roster.checked]
    )

    const log = useCallback((line: string) => {
        setStatusLines((prev) => [...prev.slice(-200), line])
    }, [])

    const clearLog = useCallback(() => setStatusLines([]), [])

    const setSolIn = (addr: string, value: string) => {
        setSolIns((prev) => ({ ...prev, [addr]: value }))
    }

    const parseCreator = (): Keypair => {
        if (!creatorKey) {
            throw new Error(
                'creator key missing: connect the base58 secret of the devnet deploy wallet in the masthead'
            )
        }
        const pubkey = pubkeyFromSecretKey(creatorKey)
        if (!pubkey) {
            throw new Error('creator key is not a valid 64-byte base58 secret')
        }
        return Keypair.fromSecretKey(bs58.decode(creatorKey))
    }

    const parseSolIn = (raw: string | undefined): bigint => {
        const n = Number(raw ?? '')
        if (!Number.isFinite(n) || n <= 0) {
            throw new Error(
                `sol_in must be a positive number, got "${raw ?? ''}"`
            )
        }
        return BigInt(Math.round(n * LAMPORTS_PER_SOL))
    }

    /** Parses the Jito bundle tip field (SOL) into lamports. Empty falls back
     *  to DEFAULT_JITO_TIP_LAMPORTS; 0 disables the tip; a positive value
     *  below Jito's 1000-lamport minimum is rejected. */
    const parseTip = (): number => {
        const raw = tipSol.trim()
        if (raw === '') return DEFAULT_JITO_TIP_LAMPORTS
        const n = Number(raw)
        if (!Number.isFinite(n) || n < 0) {
            throw new Error(`tip must be a non-negative SOL amount, got "${raw}"`)
        }
        const lamports = Math.round(n * LAMPORTS_PER_SOL)
        if (lamports > 0 && lamports < MIN_TIP_LAMPORTS) {
            throw new Error(
                `tip ${raw} SOL (${lamports} lamports) is below Jito's ${MIN_TIP_LAMPORTS} lamport minimum`
            )
        }
        return lamports
    }

    const handleLaunch = async () => {
        if (busy) return
        setBusy(true)
        setLaunchError(null)
        clearLog()
        // Signatures observed as the launch progresses (toast txHash = the first).
        const sentSigs: string[] = []
        try {
            const creator = parseCreator()

            if (Buffer.byteLength(name, 'utf8') > 32)
                throw new Error(
                    `name too long (${Buffer.byteLength(name, 'utf8')} > 32 bytes)`
                )
            if (Buffer.byteLength(symbol, 'utf8') > 10)
                throw new Error(
                    `symbol too long (${Buffer.byteLength(symbol, 'utf8')} > 10 bytes)`
                )

            if (selectedWallets.length === 0) {
                throw new Error('select at least one dev wallet in the roster')
            }

            const buys: BuyAllocation[] = []
            for (const w of selectedWallets) {
                if (!w.key) {
                    throw new Error(
                        `wallet ${shortAddress(w.address, 6)} has no key (watch-only wallets cannot sign buys)`
                    )
                }
                const rawSolIn = solIns[w.address]
                const solIn = parseSolIn(
                    rawSolIn === undefined || rawSolIn.trim() === ''
                        ? DEFAULT_SOL_IN
                        : rawSolIn
                )
                buys.push({
                    wallet: Keypair.fromSecretKey(bs58.decode(w.key)),
                    solInLamports: solIn,
                })
            }

            // M9 metadata: resolve the final on-chain uri BEFORE anything
            // hits the chain. Auto mode publishes the structured fields
            // (description / image / socials) to the configured backend (VPS
            // preferred, IPFS via Pinata the alt) and uses the returned URL;
            // manual mode keeps the raw URI field. The create() arg cap is
            // checked on the RESOLVED uri (200 bytes, the program limit).
            let finalUri: string
            if (manualMetadata) {
                finalUri = uri
                if (!finalUri.trim()) {
                    throw new Error(
                        'manual metadata uri is empty: enter a URI or disable the manual toggle'
                    )
                }
            } else {
                log('metadata: publishing description / image / socials...')
                try {
                    const pub = await publishTokenMetadata({
                        name,
                        symbol,
                        description,
                        website,
                        twitter,
                        telegram,
                        image: imageFile,
                    })
                    finalUri = pub.uri
                    log(`metadata: published via ${pub.backend} -> ${finalUri}`)
                    if (pub.imageUrl) log(`image   : ${pub.imageUrl}`)
                } catch (e) {
                    const msg = errMsg(e)
                    if (msg.includes('METADATA BACKEND NOT CONFIGURED')) {
                        log('NOTE: no metadata backend is configured on the server.')
                        log('  - set METADATA_BACKEND=vps + METADATA_VPS_UPLOAD_URL /')
                        log('    METADATA_VPS_BASE_URL / METADATA_VPS_SECRET (preferred,')
                        log('    see tools/metadata-vps/server.mjs), OR')
                        log('  - set METADATA_BACKEND=ipfs + PINATA_JWT, OR')
                        log('  - enable "manual metadata uri" in Advanced for a')
                        log('    devnet launch with no backend.')
                    }
                    throw e
                }
            }
            if (Buffer.byteLength(finalUri, 'utf8') > 200)
                throw new Error(
                    `uri too long (${Buffer.byteLength(finalUri, 'utf8')} > 200 bytes)`
                )

            log(`=== pumpfun launch (tier ${tier}) ===`)
            log(`creator : ${creator.publicKey.toBase58()}`)
            log(`name/sym: ${name} / ${symbol}`)
            log(`uri     : ${finalUri}`)
            for (const b of buys) {
                log(
                    `  dev ${b.wallet.publicKey.toBase58().slice(0, 12)}... buys ${(Number(b.solInLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`
                )
            }
            const connection = makeAppConnection()
            log(
                `program : pump.fun native (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)`
            )
            log(
                `migrate : automatic (pump.fun migrates to PumpSwap on graduation; create args = name/symbol/uri only)`
            )
            // Funding math mirrors scripts/launch-bundle.mjs: each wallet needs
            // sol_in + ATA rent + the rent-exempt floor it must retain post-buy.
            const ataRent = await ataRentLamports(connection)
            const fundLamportsPerWallet = fundFromCreator
                ? buys.map(
                      (b) =>
                          b.solInLamports +
                          BigInt(ataRent) +
                          postBuyFloorLamports()
                  )
                : null
            if (fundLamportsPerWallet) {
                const totalFund = fundLamportsPerWallet.reduce(
                    (a, b) => a + b,
                    BigInt(0)
                )
                const creatorBal = await connection.getBalance(
                    creator.publicKey,
                    'confirmed'
                )
                // The pump.fun `create_v2` instruction makes the creator fund
                // the accounts it allocates, all rent-exempt:
                //   - Token-2022 mint (~400-570B; metadata lives IN-MINT via the
                //     Token-2022 metadata extension, growing with the
                //     name/symbol/uri length — there is NO Metaplex account)
                //   - bonding curve (151B on live create_v2 tokens)
                //   - bonding-curve ATA (Token-2022 token account = 170B)
                //   - mayhem_state + mayhem_token_vault: created then CLOSED
                //     for non-mayhem tokens (net zero, but the creator must
                //     cover their rent mid-tx) — reserved as a flat buffer
                // The creator must also retain its own native rent-exempt
                // floor after the create and pay the tx fee. Sum the rent
                // minimums + the ephemeral-mayhem buffer + floor + fee.
                const mintSize =
                    340 +
                    Buffer.byteLength(name, 'utf8') +
                    Buffer.byteLength(symbol, 'utf8') +
                    Buffer.byteLength(finalUri, 'utf8')
                const createRent =
                    BigInt(await connection.getMinimumBalanceForRentExemption(mintSize)) + // Token-2022 mint
                    BigInt(await connection.getMinimumBalanceForRentExemption(151)) + // bonding curve
                    BigInt(await connection.getMinimumBalanceForRentExemption(170)) + // Token-2022 ATA
                    BigInt(await connection.getMinimumBalanceForRentExemption(340)) + // mayhem_state (ephemeral)
                    BigInt(await connection.getMinimumBalanceForRentExemption(170)) // mayhem_token_vault (ephemeral)
                const createMargin =
                    createRent + postBuyFloorLamports() + BigInt(30_000)
                const needed = totalFund + createMargin
                log(
                    `fund    : ${(Number(totalFund) / LAMPORTS_PER_SOL).toFixed(4)} SOL from creator (sol_in + ata rent + floor)`
                )
                if (creatorBal < needed) {
                    throw new Error(
                        `creator balance ${(Number(creatorBal) / LAMPORTS_PER_SOL).toFixed(4)} SOL too low; need >= ${(Number(needed) / LAMPORTS_PER_SOL).toFixed(4)} SOL (funding + create margin).`
                    )
                }
            }

            const seq = await buildLaunchSequence({
                connection,
                creator,
                name,
                symbol,
                uri: finalUri,
                buys,
                fundLamportsPerWallet,
                // Tier 1 has no bundle tip, so the full 1222-byte budget is
                // available. Tier 2 keeps the default 1150 + 90 tip reserve.
                // Measured (M10): pump.fun buy ixs pack 2 wallets per tx max.
                ...(tier === '1'
                    ? { maxBuyTxBytes: 1222, tipReserveBytes: 0 }
                    : {}),
            })
            log(
                `mint    : ${EXPLORER}/address/${seq.pda.mint.toBase58()}${EXPLORER_QS} (fresh pump.fun mint keypair; the .pump suffix is indexer-applied)`
            )
            log(
                `curve   : ${EXPLORER}/address/${seq.pda.curveState.toBase58()}${EXPLORER_QS}`
            )
            log(`packing : ${seq.buyTxs.length} buy tx(s):`)
            for (const bt of seq.buyTxs) {
                log(`   ${bt.wallets.length} wallets, ${bt.signedSize} bytes`)
            }

            log('preflight: simulating create + buy txs...')
            // The create+buy sandbox overflows the 1232-byte legacy limit after
            // pump.fun's upgrade, so the pre-flight sims use a shared address
            // lookup table (created once, reused). Cheap on devnet.
            const { account: lookupTable } = await ensurePumpLookupTable(
                connection,
                creator
            )
            const pre = await preflightLaunch(connection, seq, lookupTable)
            log(`   create: ${pre.create.unitsConsumed} CU, ok`)
            for (const c of pre.buyChunks) {
                log(
                    `   buy${c.buyTxIndex + 1} chunk (${c.walletCount}): ${c.result.unitsConsumed} CU, ok`
                )
            }

            if (tier === '1') {
                log(
                    'sending launch txs sequentially (fund -> create -> buys)...'
                )
                const sent = await sendSequentially(connection, seq, {
                    onSignature: (label, sig) => {
                        sentSigs.push(sig)
                        log(
                            `[${label}] ${sig}  ${EXPLORER}/tx/${sig}${EXPLORER_QS}`
                        )
                    },
                })
                log(
                    `sent ${sent.length} txs: ${sent.map((s) => s.label).join(', ')}`
                )
            } else {
                // Tier 2 (Jito bundle). The devnet block engine host does not
                // resolve, so on devnet a bundle can never land: the construction is
                // proved (assemble + simulate) and the result is reported honestly.
                // M7a: a non-landing bundle must NEVER fall through to the
                // "launch complete" block below, so the tier-2 outcome is captured
                // here and a non-landing result throws before any verification.
                log('tier 2: assembling jito bundle...')
                const jitoTipLamports = parseTip()
                log(
                    `tip     : ${jitoTipLamports} lamports (${(jitoTipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`
                )
                const jito = new JitoBundleClient(JITO_MAINNET_ENDPOINT)
                let unreachable: string | null = null
                let tier2Result: BundleSubmissionResult | null = null
                try {
                    const tips = await withTimeout(
                        jito.getTipAccounts(),
                        10_000,
                        'getTipAccounts timed out'
                    )
                    log(`jito endpoint reachable (${tips.length} tip accounts)`)
                } catch (e) {
                    unreachable = errMsg(e)
                    log(
                        `jito endpoint ${JITO_MAINNET_ENDPOINT}: UNREACHABLE (${unreachable})`
                    )
                    log(
                        '   matches devnet reality: devnet.block-engine.jito.wtf does not resolve;'
                    )
                    log('   devnet bundles cannot be submitted or land.')
                }
                const latest = await connection.getLatestBlockhash('confirmed')
                const tipAccount = new PublicKey(KNOWN_TIP_ACCOUNTS[0])
                const bundleTxs = [
                    seq.fundTx,
                    seq.createTx,
                    ...seq.buyTxs.map((b) => b.tx),
                ].filter((t): t is NonNullable<typeof t> => t !== null)
                const bundleSigners = seq.signersByTx
                // M10: pump.fun buy ixs pack 2 wallets per tx (measured), so a
                // launch over ~6 funded wallets produces more buy txs than the
                // 5-tx Jito bundle cap. Surface that BEFORE assembleBundle's
                // cryptic cap error with the actionable fix.
                if (bundleTxs.length > 5) {
                    const nonBuyTxs = bundleTxs.length - seq.buyTxs.length;
                    const maxWallets = 2 * (5 - nonBuyTxs);
                    throw new Error(
                        `TIER 2 BUNDLE CAP: ${bundleTxs.length} txs > the 5-tx Jito bundle limit (pump.fun buy ixs pack 2 wallets per tx). Reduce the selected dev wallets to at most ${maxWallets} or use Tier 1 (sequential sends).`
                    );
                }
                const assembled = await jito.assembleBundle({
                    txs: bundleTxs,
                    signersByTx: bundleSigners,
                    blockhash: latest.blockhash,
                    lastValidBlockHeight: latest.lastValidBlockHeight,
                    tipAccount,
                    tipLamports: jitoTipLamports,
                    tipPayer: creator,
                })
                log(
                    `bundle assembled: ${assembled.base64.length} txs, tip ${jitoTipLamports} lamports -> ${tipAccount.toBase58()}`
                )
                const tipIx = SystemProgram.transfer({
                    fromPubkey: creator.publicKey,
                    toPubkey: tipAccount,
                    lamports: jitoTipLamports,
                })
                const sims = await simulateBundle(connection, {
                    createIx: seq.createIx,
                    fundIx: seq.fundIx,
                    fundIxPerWallet: seq.fundIxPerWallet,
                    buyTxs: seq.buyTxs.map((bt) => ({
                        wallets: bt.wallets,
                        walletIxs: bt.walletIxs,
                    })),
                    tipIx,
                    creator,
                    mintKeypair: seq.mintKeypair,
                    lookupTable,
                })
                for (const s of sims)
                    log(`   ${s.label}: ${s.unitsConsumed} CU, ok`)
                if (unreachable) {
                    log(
                        'TIER 2 RESULT: bundle assembled + simulated; submission impossible on devnet'
                    )
                    log(
                        '   (block engine host does not resolve). No fabricated landing claim.'
                    )
                } else {
                    log(
                        'submitting bundle via relay fan-out (jito primary + bloxroute + astralane, same-origin proxy)...'
                    )
                    // M7b: the launch bundle is submitted through /api/bundle-relay,
                    // which fans the SAME signed bundle out to Jito (primary, open),
                    // bloXroute (JWT) and Astralane (api key) in parallel,
                    // first-accept-wins. Credentials stay server-side; only the signed
                    // base64 txs leave this page. The submitter mirrors submitWithRetry
                    // (escalating tip, same honest BundleSubmissionResult). On devnet
                    // this branch is never reached (unreachable above; the devnet
                    // probe keeps a devnet rehearsal honest). A mainnet deployment
                    // flips the reachability probe to JITO_MAINNET_ENDPOINT and the
                    // connection factory to the mainnet pool; this submission path is
                    // cluster-agnostic.
                    tier2Result = await submitBundleViaFanoutWithRetry({
                        txs: bundleTxs,
                        signersByTx: bundleSigners,
                        tipPayer: creator,
                        tipAccount,
                        initialTipLamports: jitoTipLamports,
                        maxAttempts: 3,
                        pollTimeoutMs: 40_000,
                        pollIntervalMs: 2_500,
                        connection,
                        onAttempt: (a) => {
                            const segs = [
                                `attempt ${a.attempt}`,
                                `tip ${a.tipLamports}`,
                                a.bundleId ? `bundle ${a.bundleId}` : '',
                                a.status ? `status ${a.status}` : '',
                                a.winningRelay ? `relay ${a.winningRelay}` : '',
                                a.rejectionReason
                                    ? `reason ${a.rejectionReason}`
                                    : '',
                                a.rejectionMsg ? `msg ${a.rejectionMsg}` : '',
                                a.blockhash ? `blockhash ${a.blockhash}` : '',
                                a.lastValidBlockHeight != null
                                    ? `lastValidBlockHeight ${a.lastValidBlockHeight}`
                                    : '',
                                a.txSignatures && a.txSignatures.length
                                    ? `sigs ${a.txSignatures.join(',')}`
                                    : '',
                                a.sendError ? `error ${a.sendError}` : '',
                            ].filter((s) => s !== '')
                            log(`   ${segs.join(', ')}`)
                        },
                    })
                    log(
                        `TIER 2 RESULT: ${tier2Result.outcome}${tier2Result.bundleId ? ` (bundle ${tier2Result.bundleId})` : ''}${tier2Result.landedSlot != null ? `, landed slot ${tier2Result.landedSlot}` : ''}`
                    )
                }
                // M7a bundle-drop reconciliation: only a LANDED bundle is a launch.
                // Anything else throws with an honest summary and a retry path; the
                // outer catch turns it into the FAILED toast (no LAUNCHED toast, no
                // trade-panel prefill, no phantom "launch complete").
                if (unreachable) {
                    throw new Error(
                        'TIER 2 BUNDLE COULD NOT BE SUBMITTED: the Jito devnet block engine is unreachable (devnet hosts no block engine). NOTHING WAS CREATED. On devnet use Tier 1 normal sends; on mainnet re-run after the relay wiring lands.'
                    )
                }
                if (!tier2Result || tier2Result.outcome !== 'landed') {
                    // M7b observability: a rejected bundle leaves a full trace
                    // in the log so the culprit class (TransactionFailure /
                    // ExceedsCostModel / BlockhashNotFound / TipError /
                    // nothing-landed) is identifiable without re-running. The
                    // base64 of each attempt's signed txs rides on
                    // tier2Result.attempts[].base64 for decoding against the
                    // chain (the rejection reason alone cannot name the tx).
                    const lastA = tier2Result?.attempts?.length
                        ? tier2Result.attempts[tier2Result.attempts.length - 1]
                        : null
                    const simSummary = sims
                        .map((s) => `${s.label} ${s.unitsConsumed ?? '?'} CU`)
                        .join(', ')
                    log('tier 2 diagnostic (rejected):')
                    log(`  bundle id            : ${lastA?.bundleId ?? 'none'}`)
                    log(`  status               : ${lastA?.status ?? 'n/a'}`)
                    log(
                        `  rejection reason     : ${lastA?.rejectionReason ?? 'n/a'}`
                    )
                    log(`  rejection msg        : ${lastA?.rejectionMsg ?? 'n/a'}`)
                    log(`  blockhash            : ${lastA?.blockhash ?? 'n/a'}`)
                    log(
                        `  lastValidBlockHeight : ${lastA?.lastValidBlockHeight ?? 'n/a'}`
                    )
                    log(`  tip (lamports)       : ${lastA?.tipLamports ?? 'n/a'}`)
                    log(
                        `  tx signatures        : ${
                            lastA?.txSignatures?.length
                                ? lastA.txSignatures.join(', ')
                                : 'n/a'
                        }`
                    )
                    log(`  sim/preflight        : ${simSummary || 'n/a'}`)
                    log(
                        `  attempts             : ${
                            tier2Result
                                ? tier2Result.attempts
                                      .map(
                                          (t) =>
                                              `#${t.attempt} ${t.status ?? ''}${
                                                  t.rejectionReason
                                                      ? ` (${t.rejectionReason})`
                                                      : ''
                                              }`
                                      )
                                      .join('; ')
                                : 'n/a'
                        }`
                    )
                    // Raw signed bundle(s): decode offline to diff every
                    // account/PDA against the chain. Jito's public block
                    // engine never returns a rejection_reason for Invalid
                    // bundles (getBundleStatuses -> value: []), so the signed
                    // base64 is the ONLY artifact that names the culprit tx.
                    for (const t of tier2Result?.attempts ?? []) {
                        if (t.base64?.length) {
                            log(
                                `  bundle b64 (attempt ${t.attempt}${
                                    t.bundleId ? `, id ${t.bundleId}` : ''
                                }): ${JSON.stringify(t.base64)}`
                            )
                        }
                    }
                    throw new Error(
                        tier2Result
                            ? bundleDropMessage(tier2Result)
                            : 'TIER 2 BUNDLE HAD NO RESULT: nothing was created.'
                    )
                }
            }

            // ---- post-launch verification -------------------------------
            const mint = seq.pda.mint.toBase58()
            const mintPk = seq.pda.mint
            log('')
            log('=== on-chain verification ===')
            log(`token   : ${EXPLORER}/address/${mint}${EXPLORER_QS}`)
            log(
                `curve   : ${EXPLORER}/address/${seq.pda.curveState.toBase58()}${EXPLORER_QS}`
            )

            const balances = []
            for (const b of buys) {
                const bal = await walletTokenBalance(
                    connection,
                    b.wallet.publicKey,
                    mintPk
                )
                balances.push(bal)
                log(
                    `   ${b.wallet.publicKey.toBase58().slice(0, 12)}...  ${(Number(bal) / 1e6).toFixed(6)} tokens`
                )
            }
            const rosterHolders = balances.filter((b) => b > BigInt(0)).length
            log(`holders (selected dev roster, non-zero): ${rosterHolders}`)
            try {
                const holders = await holderCount(connection, mintPk)
                log(`holders (getTokenLargestAccounts): ${holders}`)
            } catch {
                log(
                    'holders (getTokenLargestAccounts): rate-limited on the public devnet RPC;'
                )
                log(
                    '   the selected-wallet roster above is the authoritative count.'
                )
            }
            try {
                // M10: pump.fun curve state (bonding-curve PDA parsed in
                // lib/pump.ts; virtual reserves + the complete flag).
                const curveRead = await readPumpCurveState(connection, mintPk)
                if (curveRead.kind === 'ok') {
                    const c = curveRead.curve
                    log(
                        `curve state: virtualSol=${c.virtualSolReserves} virtualToken=${c.virtualTokenReserves} complete=${c.complete ? 1 : 0}`
                    )
                    log(
                        `price      : ${(Number(c.virtualSolReserves) / Number(c.virtualTokenReserves)).toFixed(6)} lamports/token`
                    )
                } else {
                    log('curve state: not found (create tx did not land?)')
                }
            } catch (e) {
                log(`curve state read failed: ${errMsg(e)}`)
            }
            const meta = await readToken2022Metadata(connection, seq.pda.mint)
            if (meta) {
                log(
                    `metadata  : name="${meta.name}" symbol="${meta.symbol}" uri=${meta.uri}`
                )
            } else {
                log(
                    'metadata  : could not decode the Token-2022 in-mint metadata'
                )
            }
            log('=== launch complete ===')

            roster.setTrackedMint(mint)
            setLastMint(mint)
            onLaunched?.(mint)
            // Toast: LAUNCHED, amount = symbol, txHash = the first signature.
            if (tier === '1' && sentSigs.length > 0) {
                pushToast({
                    action: 'LAUNCHED',
                    amount: `$${symbol}`,
                    txHash: sentSigs[0],
                })
            }
        } catch (e) {
            const rawMsg = errMsg(e)
            log(`LAUNCH FAILED: ${rawMsg}`)
            if (rawMsg.includes('METADATA BACKEND NOT CONFIGURED')) {
                log(
                    'NOTE: metadata backend not configured. Enable "manual metadata'
                )
                log(
                    '      uri" in Advanced (devnet) or set METADATA_BACKEND +'
                )
                log(
                    '      METADATA_VPS_* / PINATA_JWT in the server env (mainnet).'
                )
            }
            if (e instanceof Error && e.stack) {
                log(e.stack.split('\n').slice(0, 5).join('\n'))
            }
            // M7a error surfacing: rate-limit / expired blockhash / insufficient
            // funds / rent map to actionable text; the raw message stays in the log
            // above for debugging.
            const msg = friendlyTxError(rawMsg)
            log(`LAUNCH FAILED (friendly): ${msg}`)
            setLaunchError(msg)
            // Toast: LAUNCH FAILED. A bundle that did not land is NOT "TX
            // REVERTED": the amount line says BUNDLE DID NOT LAND so the operator
            // knows nothing was created and the retry path from the status log
            // applies. txHash = first signature seen (none when nothing sent).
            const bundleDrop =
                /BUNDLE DID NOT LAND|BUNDLE COULD NOT BE SUBMITTED|JITO BUNDLE|TIER 2 BUNDLE/i.test(
                    rawMsg
                )
            pushToast({
                action: 'LAUNCH FAILED',
                amount: bundleDrop ? 'BUNDLE DID NOT LAND' : 'TX REVERTED',
                txHash: sentSigs.length > 0 ? sentSigs[0] : undefined,
                tone: 'error',
            })
        } finally {
            setBusy(false)
        }
    }

    // M6 SELL ALL (moved here from the trade card's tab strip 2026-09-04):
    // one button below Launch sells EVERY keyed managed wallet's full token
    // balance of the mint the Trade panel tracks (a launch pre-fills that
    // field). Route on curve state: curve sell while open, PumpSwap pool
    // sell after graduation (lib/sell-all.ts). Ignores the roster checkbox
    // selection like the old tab did.
    const [sellBusy, setSellBusy] = useState(false)
    const [sellError, setSellError] = useState<string | null>(null)
    const [sellReport, setSellReport] = useState<SellAllReport | null>(null)
    const keyedCount = roster.wallets.filter((w) => w.key).length

    const handleSellAll = async () => {
        if (sellBusy) return
        if (!mint) {
            setSellError(
                'ENTER THE TOKEN MINT IN THE TRADE PANEL TO SELL ALL (A LAUNCH PRE-FILLS IT)'
            )
            return
        }
        if (keyedCount === 0) {
            setSellError(
                'NO KEYED MANAGED WALLETS TO SELL (IMPORT BASE58 SECRETS IN THE ROSTER FIRST)'
            )
            return
        }
        setSellBusy(true)
        setSellError(null)
        setSellReport(null)
        const sigs: string[] = []
        try {
            const connection = makeAppConnection()
            // M10: sellAllManagedWallets signs every sell with the roster
            // Keypairs and hand-builds the pump.fun sell ixs itself (no anchor
            // Program, no IDL) — only the connection + mint + roster are needed.
            const report = await sellAllManagedWallets({
                connection,
                mint: new PublicKey(mint),
                wallets: roster.wallets,
                slippagePct: 5,
            })
            setSellReport(report)
            roster.refreshBalances()
            for (const o of report.outcomes) {
                if (o.signature) sigs.push(o.signature)
            }
            if (report.sold > 0) {
                pushToast({
                    action: 'SELL ALL',
                    amount: `${report.sold} WALLETS SOLD`,
                    txHash: sigs[0],
                })
            } else if (report.failed > 0) {
                pushToast({
                    action: 'SELL ALL',
                    amount: '0 SOLD',
                    tone: 'error',
                })
            } else {
                pushToast({
                    action: 'SELL ALL',
                    amount: '0 SOLD (ALL SKIPPED)',
                })
            }
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e)
            // M7a: rate-limit / expired blockhash / insufficient-funds / rent
            // map to actionable text instead of a raw RPC dump.
            const msg = friendlyTxError(raw)
            setSellError(msg)
            pushToast({
                action: 'SELL ALL FAILED',
                amount: 'TX REVERTED',
                tone: 'error',
            })
        } finally {
            setSellBusy(false)
        }
    }

    return (
        <Card
            head={
                <div className="flex items-center justify-between">
                    <span className="label-mono !text-[13px]">Launch</span>
                    <span className="label-mono opacity-50">
                        Solana · Devnet
                    </span>
                </div>
            }
            className="flex-1 lg:flex-0 lg:min-w-1/3 lg:sticky lg:top-0 lg:self-start lg:z-30">
            <div className="flex flex-col gap-4">
                <Field label="Token Name">
                    <Input
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        placeholder="Sample Coin"
                        spellCheck={false}
                    />
                </Field>
                <Field label="Token Symbol">
                    <Input
                        value={symbol}
                        onChange={(e) => setSymbol(e.target.value)}
                        placeholder="SMPL"
                        spellCheck={false}
                    />
                </Field>

                <Collapse
                    open={advancedOpen}
                    onToggle={() => setAdvancedOpen((v) => !v)}
                    label="Advanced">
                    <div className="lg:col-span-4">
                        <div className="flex items-center justify-between gap-2">
                            <span className="label-mono opacity-70">
                                token metadata · auto-published on launch
                            </span>
                            <label className="label-mono flex items-center gap-2 cursor-pointer text-[11px] opacity-80">
                                <input
                                    type="checkbox"
                                    className="checkbox-brutal"
                                    checked={manualMetadata}
                                    onChange={(e) =>
                                        setManualMetadata(e.target.checked)
                                    }
                                />
                                manual metadata uri
                            </label>
                        </div>
                        {manualMetadata ? (
                            <div className="mt-3">
                                <Field label="Metadata URI">
                                    <Input
                                        value={uri}
                                        onChange={(e) =>
                                            setUri(e.target.value)
                                        }
                                        placeholder="https://.../metadata.json"
                                        spellCheck={false}
                                    />
                                </Field>
                            </div>
                        ) : (
                            <div className="mt-3 grid gap-3 md:grid-cols-2">
                                <div className="md:col-span-2">
                                    <Field label="Description">
                                        <textarea
                                            className="input-brutal min-h-[72px] resize-y font-sans"
                                            value={description}
                                            onChange={(e) =>
                                                setDescription(e.target.value)
                                            }
                                            placeholder="What the token is for (stored in the metadata JSON)."
                                            spellCheck={false}
                                        />
                                    </Field>
                                </div>
                                <Field
                                    label="Token Image"
                                    aside={
                                        imageFile
                                            ? imageFile.name
                                            : 'OPTIONAL - png/jpg/gif/webp/svg'
                                    }>
                                    <input
                                        type="file"
                                        accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
                                        className="input-brutal cursor-pointer file:mr-2 file:border-0 file:bg-ink file:px-2 file:py-1 file:font-mono file:text-[10px] file:text-paper file:uppercase"
                                        onChange={(e) => {
                                            const f = e.target.files
                                            setImageFile(
                                                f && f.length > 0 ? f[0] : null
                                            )
                                        }}
                                    />
                                </Field>
                                <Field label="Website">
                                    <Input
                                        value={website}
                                        onChange={(e) =>
                                            setWebsite(e.target.value)
                                        }
                                        placeholder="https://yoursite.com"
                                        spellCheck={false}
                                    />
                                </Field>
                                <Field label="X / Twitter">
                                    <Input
                                        value={twitter}
                                        onChange={(e) =>
                                            setTwitter(e.target.value)
                                        }
                                        placeholder="@handle or https://x.com/handle"
                                        spellCheck={false}
                                    />
                                </Field>
                                <Field label="Telegram">
                                    <Input
                                        value={telegram}
                                        onChange={(e) =>
                                            setTelegram(e.target.value)
                                        }
                                        placeholder="@handle or https://t.me/group"
                                        spellCheck={false}
                                    />
                                </Field>
                            </div>
                        )}
                    </div>

                    {/* M10: pump.fun auto-migrates on graduation (the old M3
                    custom-program toggles are gone; the create args are ONLY
                    name/symbol/uri) + funding */}
                    <div className="lg:col-span-4">
                        <div className="flex flex-wrap items-center gap-4 border-2 border-ink px-3 py-2">
                            
                            <label className="label-mono flex items-center gap-2 cursor-pointer opacity-80 ml-auto">
                                <input
                                    type="checkbox"
                                    className="checkbox-brutal"
                                    checked={fundFromCreator}
                                    onChange={(e) =>
                                        setFundFromCreator(e.target.checked)
                                    }
                                />
                                fund wallets from creator
                            </label>
                        </div>
                    </div>

                    {/* per-wallet sol_in for the selected dev wallets */}
                    <div className="lg:col-span-4">
                        <div className="flex items-center gap-3">
                            <span className="label-mono opacity-70">
                                dev wallets (selected in the roster)
                            </span>
                            <span className="label-mono ml-auto opacity-60">
                                {selectedWallets.length} selected
                            </span>
                        </div>
                    </div>
                    <div className="min-w-full grid md:grid-cols-2 lg:grid-cols-3 gap-4">
                        {selectedWallets.map((w) => (
                            <Field
                                key={w.address}
                                label={shortAddress(w.address, 6)}
                                aside={w.key ? undefined : 'NO KEY'}>
                                <Input
                                    type="number"
                                    min={0}
                                    step={0.001}
                                    value={solIns[w.address] ?? DEFAULT_SOL_IN}
                                    onChange={(e) =>
                                        setSolIn(w.address, e.target.value)
                                    }
                                    className="font-mono text-[12px]"
                                    aria-label={`sol_in for ${shortAddress(w.address, 6)}`}
                                />
                            </Field>
                        ))}
                    </div>
                </Collapse>

                {launchError ? (
                    <StatusLine
                        text={`LAST ERROR: ${launchError}`}
                        tone="error"
                    />
                ) : null}
                {lastMint ? (
                    <div className="flex items-center gap-2">
                        <StatusLine text="LAST MINT:" />
                        <ExplorerLink hash={lastMint} kind="address" />
                    </div>
                ) : null}

                <div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-ink pt-3">
                    <div className="flex items-center gap-2">
                        <label
                            className="label-mono flex items-center gap-1.5 opacity-80"
                            title="Jito bundle tip in SOL (Tier 2 only). Empty uses the default.">
                            tip
                            <Input
                                type="number"
                                min={0}
                                step={0.0001}
                                value={tipSol}
                                onChange={(e) => setTipSol(e.target.value)}
                                placeholder={DEFAULT_TIP_SOL}
                                className="w-24 font-mono text-[12px]"
                                aria-label="Jito bundle tip in SOL"
                            />
                            SOL
                        </label>
                        <Btn
                            onClick={() => void handleLaunch()}
                            disabled={busy || !connected}>
                            {busy ? 'LAUNCHING...' : 'Launch'}
                        </Btn>
                    </div>
                    <span className="label-mono opacity-60">
                        {!connected
                            ? 'CONNECT CREATOR KEY IN THE MASTHEAD'
                            : `CREATOR ${creatorPubkey ? shortAddress(creatorPubkey, 6) : ''} · ${balanceSol}`}
                    </span>
                </div>

                {/* Sell All (M6, moved here from the trade card's tab strip
                2026-09-04): the SELL ALL tab became this single
                always-visible button below Launch. It ignores the roster
                checkbox selection and sweeps every keyed managed wallet's
                full balance of the mint the Trade panel tracks. */}
                <div className="flex flex-col gap-2 border-t-2 border-ink pt-3">
                    <Btn
                        invert
                        onClick={() => void handleSellAll()}
                        disabled={sellBusy || !mint || keyedCount === 0}
                        className="w-full shadow-none!">
                        {sellBusy ? 'Selling...' : 'Sell All'}
                    </Btn>
                    {!mint ? (
                        <StatusLine
                            text="ENTER THE TOKEN MINT IN THE TRADE PANEL TO SELL ALL (A LAUNCH PRE-FILLS IT)"
                            tone="idle"
                        />
                    ) : null}
                    {mint && keyedCount === 0 ? (
                        <StatusLine
                            text="NO KEYED WALLETS. IMPORT BASE58 SECRETS IN THE ROSTER FIRST"
                            tone="idle"
                        />
                    ) : null}
                    {sellError ? (
                        <StatusLine
                            text={`SELL ALL FAILED: ${sellError}`}
                            tone="error"
                        />
                    ) : null}
                    {sellBusy ? (
                        <StatusLine
                            text="SELLING EVERY KEYED WALLET'S FULL BALANCE (CONCURRENT)..."
                            tone="idle"
                        />
                    ) : null}
                    {sellReport ? (
                        <SellAllReportView report={sellReport} />
                    ) : null}
                </div>

                {/* status log (preserved from M4) */}
                <div>
                    <div className="mb-1">
                        <span className="label-mono opacity-50">log</span>
                    </div>
                    <pre className="min-h-[120px] max-h-[260px] overflow-auto bg-ink text-paper p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
                        {statusLines.length === 0
                            ? 'ready. fill the form and press launch.'
                            : statusLines.join('\n')}
                    </pre>
                </div>
            </div>
        </Card>
    )
}

/* ---------- M6 sell-all report (final count, per-wallet SOL, holders) ---------- */

function SellAllReportView({ report }: { report: SellAllReport }) {
    const routeLabel =
        report.route === 'curve'
            ? `ROUTE: CURVE SELL (NOT GRADUATED) · creator ${shortAddress(report.creator, 6)}`
            : `ROUTE: PUMSWAP SELL (GRADUATED) · pool ${shortAddress(report.poolKey ?? '', 6)}`
    return (
        <div className="flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
            <p className="label-mono !text-[10px] font-bold break-all">{routeLabel}</p>
            <p className="label-mono !text-[11px] font-bold">
                SOLD {report.sold}/{report.total} · SKIPPED {report.skipped} · FAILED {report.failed}
            </p>
            <div className="flex flex-col gap-0.5">
                {report.outcomes.map((o) => (
                    <SellOutcomeRow key={o.address} outcome={o} />
                ))}
            </div>
            <p className="label-mono !text-[10px] border-t border-ink/40 pt-1">
                HOLDERS AFTER:{' '}
                {report.holderCountAfter === null
                    ? 'READ FAILED (RATE-LIMITED); CHECK ROSTER TOKEN COLUMN'
                    : `${report.holderCountAfter}`}
            </p>
        </div>
    )
}

function SellOutcomeRow({ outcome }: { outcome: SellOutcome }) {
    const addr = shortAddress(outcome.address, 6)
    let body
    if (outcome.status === 'sold') {
        body = (
            <span>
                SOLD {fmtTokens(outcome.tokenSold)} TOK →{' '}
                {formatSolLamports(outcome.solReceivedLamports)}
                {outcome.signature ? (
                    <span className="ml-1">
                        <ExplorerLink hash={outcome.signature} />
                    </span>
                ) : null}
            </span>
        )
    } else if (outcome.status === 'skipped') {
        body = <span>SKIPPED ({outcome.reason ?? 'no key / zero balance'})</span>
    } else {
        body = <span>FAILED ({outcome.reason ?? 'error'})</span>
    }
    return (
        <p className="label-mono !text-[10px] break-all opacity-90">
            {addr} {body}
        </p>
    )
}
