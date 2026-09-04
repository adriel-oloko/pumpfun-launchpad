'use client'

// Milestone M4: the launch panel (M4-UI-MATCH restyle).
//
// Form: token name / symbol / metadata URI (direct entry; see the
// Arweave/IPFS decision comment below), the connected creator key (the
// SAME wallet the masthead connects via pumpfun.creatorKey.v1), the
// selected dev wallets with a per-wallet sol_in, the M3 migration toggles,
// and a Launch button that drives lib/bundle:
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
// M3 capability: the create() args auto_migrate + lock_lp are sent ONLY
// when the loaded IDL declares them (createMigrationCapability). On a
// pre-M3 IDL the toggles are disabled behind a "requires program upgrade"
// note and the launch proceeds with the pre-M3 4-arg create, exactly as
// buildLaunchSequence reports via migrationArgsSupported (never silently
// dropped).
//
// METADATA URI / IMAGE (Arweave vs IPFS decision):
// Production metadata JSON should be uploaded to a permanent store, either
// Arweave (permanent, paid once) or IPFS (content-addressed, needs a pin),
// and the resulting URI stored in the on-chain Metaplex metadata account.
// An upload-service stub is deliberately NOT wired this milestone: devnet
// verification works with any direct http(s) URI (the create() arg is a
// plain <=200-byte string; the mpl account stores it verbatim and the
// explorer renders the image field from that JSON). A future upload stub
// replaces the direct entry with the Arweave/IPFS URL it produces. The
// image itself lives INSIDE the metadata JSON (standard `image` field), so
// this one field covers both image and metadata.
//
// M4-UI-MATCH: the layout now mirrors v4-launchpad's Launch card (Card +
// Field + Input + Collapse primitives, "Launch" card head). The status log
// and ALL M4 launch logic are preserved unchanged.

import { Program, type Provider } from '@coral-xyz/anchor'
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
    holderCount,
    postBuyFloorLamports,
    preflightLaunch,
    readMetadataStrings,
    sendSequentially,
    simulateBundle,
    walletTokenBalance,
    withTimeout,
    type BuyAllocation,
} from '../lib/bundle'
import {
    JITO_DEVNET_ENDPOINT,
    JitoBundleClient,
    KNOWN_TIP_ACCOUNTS,
    MIN_TIP_LAMPORTS,
    type BundleSubmissionResult,
} from '../lib/bundle/jito'
import { submitBundleViaFanoutWithRetry } from '../lib/bundle/fanout-submit'
import { bundleDropMessage, friendlyTxError } from '../lib/tx-errors'
import { makeDevnetConnection } from '../lib/connection'
import { useCreatorWallet } from '../lib/creator-wallet'
import {
    createMigrationCapability,
    PUMPFUN_IDL,
    PUMPFUN_PROGRAM_ID,
    type CreateMigrationCapability,
} from '../lib/idl'
import { pubkeyFromSecretKey } from '../lib/managed-wallets'
import { DEFAULT_AUTO_MIGRATE, DEFAULT_LOCK_LP } from '../lib/params'
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
const DEFAULT_SOL_IN = '0.01'

function errMsg(e: unknown): string {
    if (e instanceof Error) return e.message
    return String(e)
}

export function LaunchPanel({
    roster,
    onLaunched,
}: {
    roster: RosterApi
    /** Called with the mint after a successful launch (pre-fills the trade
     *  panel's token-address input, mirroring v4's LAUNCH -> trade flow). */
    onLaunched?: (mint: string) => void
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
    const [advancedOpen, setAdvancedOpen] = useState(false)
    const [tier, setTier] = useState<'1' | '2'>('1')
    const [fundFromCreator, setFundFromCreator] = useState(true)
    const [solIns, setSolIns] = useState<Record<string, string>>({})
    const [autoMigrate, setAutoMigrate] = useState(DEFAULT_AUTO_MIGRATE)
    const [lockLp, setLockLp] = useState(DEFAULT_LOCK_LP)
    const [busy, setBusy] = useState(false)
    const [statusLines, setStatusLines] = useState<string[]>([])
    const [launchError, setLaunchError] = useState<string | null>(null)
    const [lastMint, setLastMint] = useState<string | null>(null)

    const capability: CreateMigrationCapability = useMemo(
        () => createMigrationCapability(PUMPFUN_IDL),
        []
    )
    const migrationSupported = capability.autoMigrate && capability.lockLp

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
            if (Buffer.byteLength(uri, 'utf8') > 200)
                throw new Error(
                    `uri too long (${Buffer.byteLength(uri, 'utf8')} > 200 bytes)`
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

            log(`=== pumpfun launch (tier ${tier}) ===`)
            log(`creator : ${creator.publicKey.toBase58()}`)
            log(`name/sym: ${name} / ${symbol}`)
            log(`uri     : ${uri}`)
            for (const b of buys) {
                log(
                    `  dev ${b.wallet.publicKey.toBase58().slice(0, 12)}... buys ${(Number(b.solInLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`
                )
            }
            log(
                `migrate : auto_migrate=${autoMigrate} lock_lp=${lockLp} (idl ${capability.autoMigrate && capability.lockLp ? 'supports' : 'PRE-M3, not supported'})`
            )

            const connection = makeDevnetConnection()
            // The anchor Wallet class is Node-only (dist/browser does not export
            // it), and the browser launch flow signs every tx manually with the
            // Keypairs (buildLaunchSequence -> signTx -> sendRawTransaction). The
            // Program instance is used only to encode instructions from the IDL
            // and fetch accounts, so a minimal provider object suffices.
            const provider = {
                connection,
                publicKey: creator.publicKey,
                wallet: { publicKey: creator.publicKey },
            } as Provider
            const program = new Program(PUMPFUN_IDL, provider)

            const nonce = BigInt(Date.now())
            log(`nonce   : ${nonce}`)
            log(
                `mint    : ${EXPLORER}/address/${PUMPFUN_PROGRAM_ID.toBase58()} (program) — pda below`
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
                const needed =
                    totalFund + BigInt(Math.round(0.02 * LAMPORTS_PER_SOL))
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
                program,
                connection,
                creator,
                nonce,
                name,
                symbol,
                uri,
                buys,
                fundLamportsPerWallet,
                // Tier 1 has no bundle tip, so the full 1222-byte budget is
                // available (5 wallets = 1173 bytes fit one buy tx). Tier 2 keeps
                // the default 1150 + 90 tip reserve.
                ...(tier === '1'
                    ? { maxBuyTxBytes: 1222, tipReserveBytes: 0 }
                    : {}),
                autoMigrate,
                lockLp,
            })
            log(
                `create args: ${seq.migrationArgsSupported ? 'auto_migrate + lock_lp SENT (M3 idl)' : 'pre-M3 create() (flags NOT sent; toggles disabled)'}`
            )
            log(`packing : ${seq.buyTxs.length} buy tx(s):`)
            for (const bt of seq.buyTxs) {
                log(`   ${bt.wallets.length} wallets, ${bt.signedSize} bytes`)
            }

            log('preflight: simulating create + buy txs...')
            const pre = await preflightLaunch(connection, seq)
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
                            `[${label}] ${sig}  ${EXPLORER}/tx/${sig}?cluster=devnet`
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
                const jito = new JitoBundleClient(JITO_DEVNET_ENDPOINT)
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
                        `jito endpoint ${JITO_DEVNET_ENDPOINT}: UNREACHABLE (${unreachable})`
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
                const assembled = await jito.assembleBundle({
                    txs: bundleTxs,
                    signersByTx: bundleSigners,
                    blockhash: latest.blockhash,
                    lastValidBlockHeight: latest.lastValidBlockHeight,
                    tipAccount,
                    tipLamports: MIN_TIP_LAMPORTS,
                    tipPayer: creator,
                })
                log(
                    `bundle assembled: ${assembled.base64.length} txs, tip ${MIN_TIP_LAMPORTS} lamports -> ${tipAccount.toBase58()}`
                )
                const tipIx = SystemProgram.transfer({
                    fromPubkey: creator.publicKey,
                    toPubkey: tipAccount,
                    lamports: MIN_TIP_LAMPORTS,
                })
                const sims = await simulateBundle(connection, {
                    createIx: seq.createIx,
                    fundIx: seq.fundIx,
                    fundIxPerWallet: seq.fundIxPerWallet,
                    buyTxs: seq.buyTxs.map((bt) => ({
                        wallets: bt.wallets,
                        instructions: bt.instructions,
                    })),
                    tipIx,
                    creator,
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
                        initialTipLamports: MIN_TIP_LAMPORTS,
                        maxAttempts: 3,
                        pollTimeoutMs: 40_000,
                        pollIntervalMs: 2_500,
                        connection,
                        onAttempt: (a) =>
                            log(
                                `   attempt ${a.attempt}: tip ${a.tipLamports}${a.bundleId ? `, bundle ${a.bundleId}` : ''}${a.status ? `, status ${a.status}` : ''}${a.sendError ? `, error: ${a.sendError}` : ''}`
                            ),
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
            log(`token   : ${EXPLORER}/address/${mint}?cluster=devnet`)
            log(
                `curve   : ${EXPLORER}/address/${seq.pda.curveState.toBase58()}?cluster=devnet`
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
                // The loose Idl cast makes the account namespace untyped; the
                // runtime key follows the IDL account name (CurveStateAccount).
                const curveAccount = (
                    program.account as unknown as {
                        curveStateAccount: {
                            fetch: (key: PublicKey) => Promise<{
                                solReserve: { toString(): string }
                                tokenReserve: { toString(): string }
                                supplyOut: { toString(): string }
                            }>
                        }
                    }
                ).curveStateAccount
                const curve = await curveAccount.fetch(seq.pda.curveState)
                log(
                    `curve state: solReserve=${curve.solReserve.toString()} tokenReserve=${curve.tokenReserve.toString()} supplyOut=${curve.supplyOut.toString()}`
                )
                log(
                    `price      : ${(Number(curve.solReserve.toString()) / Number(curve.tokenReserve.toString())).toFixed(6)} lamports/token`
                )
            } catch (e) {
                log(`curve state read failed: ${errMsg(e)}`)
            }
            const meta = await readMetadataStrings(connection, seq.pda.metadata)
            if (meta) {
                log(
                    `metadata  : name="${meta.name}" symbol="${meta.symbol}" uri=${meta.uri}`
                )
            } else {
                log('metadata  : could not decode the metadata account')
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
            if (e instanceof Error && e.stack) {
                log(e.stack.split('\n').slice(0, 5).join('\n'))
            }
            // The pre-M3 deployed program rejects the M3 buy shape (its Buy
            // account list is 8, the new one is 10) with InvalidProgramId 3008
            // at the system_program slot. The flags were NOT silently dropped:
            // they are encoded per the loaded IDL. The launch works the moment
            // M3's anchor deploy lands (verified against the M3 .so on a local
            // validator). Surface that instead of the cryptic chain error.
            if (
                rawMsg.includes('InvalidProgramId') ||
                rawMsg.includes('Custom":3008')
            ) {
                log(
                    'NOTE: this is the pre-M3 deployed program rejecting the M3 buy shape'
                )
                log(
                    '      (the on-chain program predates the M3 upgrade; M3 anchor deploy pending).'
                )
                log(
                    '      The migration flags were encoded but the old program cannot execute the new'
                )
                log(
                    '      buy accounts. Re-launch after M3 deploys; no code change needed.'
                )
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
                        <Field label="Metadata URI">
                            <Input
                                value={uri}
                                onChange={(e) => setUri(e.target.value)}
                                placeholder="https://.../metadata.json"
                                spellCheck={false}
                            />
                        </Field>
                    </div>

                    {/* migration toggles (M3 capability-gated) */}
                    <div className="lg:col-span-4">
                        <div className="flex flex-wrap items-center gap-4 border-2 border-ink px-3 py-2">
                            <label className="label-mono flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="checkbox-brutal"
                                    checked={autoMigrate}
                                    disabled={!migrationSupported}
                                    onChange={(e) =>
                                        setAutoMigrate(e.target.checked)
                                    }
                                />
                                auto-migrate
                            </label>
                            <label className="label-mono flex items-center gap-2 cursor-pointer">
                                <input
                                    type="checkbox"
                                    className="checkbox-brutal"
                                    checked={lockLp}
                                    disabled={!migrationSupported}
                                    onChange={(e) =>
                                        setLockLp(e.target.checked)
                                    }
                                />
                                lp-lock
                            </label>
                        </div>
                    </div>

                    {/* tier + funding */}
                    <div className="lg:col-span-4">
                        <div className="flex flex-wrap items-center gap-4 border-2 border-ink px-3 py-2">
                            <span className="label-mono opacity-70">
                                send path
                            </span>
                            <div className="flex gap-2">
                                <Btn
                                    type="button"
                                    invert={tier !== '1'}
                                    pressed={tier === '1'}
                                    onClick={() => setTier('1')}
                                    disabled={busy}
                                    className="!px-3 !py-1 !text-[10px]">
                                    Tier 1 Send
                                </Btn>
                                <Btn
                                    type="button"
                                    invert={tier !== '2'}
                                    pressed={tier === '2'}
                                    onClick={() => setTier('2')}
                                    disabled={busy}
                                    className="!px-3 !py-1 !text-[10px]">
                                    Tier 2 Bundle
                                </Btn>
                            </div>
                            <label className="label-mono flex items-center gap-2 cursor-pointer opacity-80">
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
                        {selectedWallets.length === 0 && (
                            <p className="label-mono opacity-60 mt-1">
                                no wallets selected: check rows in the roster
                            </p>
                        )}
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
                    <Btn
                        onClick={() => void handleLaunch()}
                        disabled={busy || !connected}>
                        {busy ? 'LAUNCHING...' : 'Launch'}
                    </Btn>
                    <span className="label-mono opacity-60">
                        {!connected
                            ? 'CONNECT CREATOR KEY IN THE MASTHEAD'
                            : `CREATOR ${creatorPubkey ? shortAddress(creatorPubkey, 6) : ''} · ${balanceSol}`}
                    </span>
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
