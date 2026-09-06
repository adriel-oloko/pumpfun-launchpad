'use client'

// Milestone M4-UI-MATCH: the Trade card, mirroring v4-launchpad's
// trade-panel structure (card head, token-address field, radio tabs-lift,
// shared roster region below the tabs), feature-mapped to the pumpfun
// Solana spec:
//
//   - Token address input selects the curve MINT the roster's token column
//     tracks (any valid base58 Solana mint; a launch pre-fills it).
//   - Managed-wallet tabs (radio `tabs-lift`, name="managed-tabs"):
//       * BUY / SELL tab (M8A, 2026-09-03): FIRST tab + defaultChecked.
//         Manual batch trade over the CHECKED keyed wallets: buy buyPct% of
//         each wallet's spendable SOL / sell sellPct% of each wallet's own
//         token balance (lib/batch-trade.ts, concurrent per-wallet signed
//         txs). Global keyboard shortcuts b/B = buy, s/S = sell (only while
//         this tab is active, the FIRST managed-tabs radio), d/D = deselect
//         (any tab). Reverses the M4 "manual Buy/Sell omitted by spec"
//         decision (the v4 gap closure; see M8A-MANUAL-BUYSELL-PROMPT.md).
//       * AUTO tab: auto buy / auto sell bot (Milestone M5): the v4 engine
//         ported to Solana (recursive round timers, shared round lock,
//         balance-gated random picks, MIN SOL / MIN % gates, roster flash,
//         countdown, graduation guard).
//       * (Sell All moved OUT of the tab strip 2026-09-04: the M6 engine is
//         now a single button below the Launch button in the Launch card —
//         it sells every keyed managed wallet's full balance of THIS mint,
//         lib/sell-all.ts.)
//       * DISTRIBUTE tab (M8C, 2026-09-03): SOL ops over the CHECKED
//         wallets. Disperse funds them from the HUB (the FIRST roster
//         wallet) in one tx; Withdraw sweeps the checked KEYED wallets to
//         a destination (each keeps the rent floor); Delete batch-removes
//         the checked wallets whose SOL is below the dust floor
//         (lib/disperse.ts, DUST_SOL_LAMPORTS in lib/params.ts).
//   - The roster (import, batch selection, balances) sits inside this card
//     under the tabs exactly like v4.

import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { useEffect, useRef, useState } from 'react'
import {
    autoSellMinRaw,
    clampAutoCount,
    clampAutoDurationMs,
    fireAutoBuy,
    fireAutoSell,
    parseAutoMinPct,
    parseAutoMinSol,
    pickRandomKeyedWallets,
    readAutoCurveState,
    type AutoCurveInfo,
    type AutoRoundResult,
    type AutoWallet,
} from '../lib/auto'
import { makeAppConnection } from '../lib/connection'
import { friendlyTxError } from '../lib/tx-errors'
import {
    buySelectedWallets,
    sellSelectedWallets,
    type ManualBatchResult,
} from '../lib/batch-trade'
import { readToken2022Metadata } from '../lib/bundle'
import {
    WITHDRAW_FEE_RESERVE_LAMPORTS,
    deleteEmptyWallets,
    disperseSol,
    withdrawSol,
    type DisperseResult,
    type WithdrawOutcome,
} from '../lib/disperse'
import { shortAddress } from '../lib/format'
import { isValidPubkey } from '../lib/managed-wallets'
import { DUST_SOL_LAMPORTS } from '../lib/params'
import { formatSolLamports } from '../lib/sell-all'
import { Roster, type RosterApi } from './roster'
import { useToasts } from './toast-stack'
import { Btn, Card, ExplorerLink, Field, Input, StatusLine } from './ui'

export function TradePanel({
    api,
    tokenAddr,
    onTokenAddrChange,
}: {
    api: RosterApi
    tokenAddr: string
    onTokenAddrChange: (v: string) => void
}) {
    // The curve mint the roster tracks: the trade token input when it is a
    // valid base58 pubkey, else nothing.
    const trimmed = tokenAddr.trim()
    const mint = isValidPubkey(trimmed) ? trimmed : null

    // M5 AUTO inputs: v4's exact field set (Auto Buy: MIN SOL / WALLET COUNT /
    // DURATION, Auto Sell: MIN % / WALLET COUNT / DURATION). Count + duration
    // prefill v4's defaults; MIN SOL / MIN % stay blank = no gate (below min
    // only skips when a threshold is actually typed; tiny devnet balances
    // should not be gated out of the box).
    const [autoBuyOn, setAutoBuyOn] = useState(false)
    const [autoBuyMinSol, setAutoBuyMinSol] = useState('')
    const [autoBuyWallets, setAutoBuyWallets] = useState('1')
    const [autoBuyDuration, setAutoBuyDuration] = useState('15')
    const [autoSellOn, setAutoSellOn] = useState(false)
    const [autoSellMinPct, setAutoSellMinPct] = useState('')
    const [autoSellWallets, setAutoSellWallets] = useState('1')
    const [autoSellDuration, setAutoSellDuration] = useState('25')

    // pushToast serves the manual Buy/Sell + Auto + Distribute tabs. (The M6
    // Sell All action moved to the Launch card, below the Launch button,
    // 2026-09-04: it lives in launch-panel.tsx with the report views.)
    const { pushToast } = useToasts()

    const inputCls = 'font-mono text-[12px]'

    // Token identity for the header: on-chain name/symbol/uri come from the
    // mint's Token-2022 in-mint metadata extension, image + socials from a
    // best-effort fetch of the off-chain JSON at that uri. Each read is stored
    // WITH its mint so a stale async result can never paint over a newer
    // mint's header: the derived locals below fall back to empty until
    // header.mint matches the current mint input (no synchronous setState in
    // the effect body).
    const [tokenHeader, setTokenHeader] = useState<TokenHeaderInfo | null>(null)
    const tokenMeta =
        tokenHeader && mint && tokenHeader.mint === mint
            ? tokenHeader.meta
            : null
    const tokenJson =
        tokenHeader && mint && tokenHeader.mint === mint
            ? tokenHeader.json
            : null
    const metaStatus =
        tokenHeader && mint && tokenHeader.mint === mint
            ? tokenHeader.status
            : 'idle'
    useEffect(() => {
        if (!mint) return
        let cancelled = false
        ;(async () => {
            setTokenHeader({ mint, meta: null, json: null, status: 'loading' })
            try {
                const connection = makeAppConnection()
                const meta = await readToken2022Metadata(
                    connection,
                    new PublicKey(mint)
                )
                if (cancelled) return
                if (!meta) {
                    setTokenHeader({
                        mint,
                        meta: null,
                        json: null,
                        status: 'error',
                    })
                    return
                }
                setTokenHeader({ mint, meta, json: null, status: 'ok' })
                const json = await readTokenMetaJson(meta.uri)
                if (cancelled) return
                setTokenHeader({ mint, meta, json, status: 'ok' })
            } catch {
                if (!cancelled) {
                    setTokenHeader({
                        mint,
                        meta: null,
                        json: null,
                        status: 'error',
                    })
                }
            }
        })()
        return () => {
            cancelled = true
        }
    }, [mint])

    // ------------------------------------------------------------------
    // M5 auto buy/sell engine (port of v4's scheduler, ETH -> SOL)
    // ------------------------------------------------------------------
    // Each enabled direction runs its own recursive timer. Every tick picks
    // `count` RANDOM keyed wallets gated by the direction's balance (buy: SOL
    // >= MIN SOL; sell: token balance > 0 and >= MIN % of total supply) and
    // fires each wallet's own signed tx concurrently, reporting only the final
    // completed count. A SINGLE shared lock (autoLockRef) serializes buy and
    // sell rounds so they never race the same wallet: a tick that finds a
    // round in flight shows WAITING ON INCLUSION and reschedules. The next
    // round is scheduled at round START (never in the .finally), so the
    // countdown keeps ticking while the round builds and sends.
    //
    // Graduation guard: before each round the curve state is fetched; a
    // graduated curve stops the bot with GRADUATED (buy/sell revert on-chain
    // after graduation, and post-graduation PumpSwap trading is out of M5
    // scope).

    const [autoRunning, setAutoRunning] = useState(false)
    const [autoStatus, setAutoStatus] = useState<string | null>(null)
    const [autoBuyLeft, setAutoBuyLeft] = useState<number | null>(null)
    const [autoSellLeft, setAutoSellLeft] = useState<number | null>(null)

    const autoRunningRef = useRef(false)
    const autoLockRef = useRef(false)
    const autoBuyTimerRef = useRef<number | null>(null)
    const autoSellTimerRef = useRef<number | null>(null)
    // Round-end timestamps (ms) feeding the live "seconds left" readouts.
    const autoBuyEndRef = useRef<number | null>(null)
    const autoSellEndRef = useRef<number | null>(null)
    const deselectTimerRef = useRef<number | null>(null)
    // One connection reused across rounds (built lazily). No anchor Program:
    // pump.fun instructions are hand-built (lib/pump.ts) and every tx is
    // signed manually with the roster Keypairs.
    const engineRef = useRef<ReturnType<typeof makeAppConnection> | null>(null)

    // Latest-render mirrors: the recursive timers close over these refs so
    // they always read current roster/inputs/state, never a stale closure.
    const walletsRef = useRef(api.wallets)
    const balancesRef = useRef(api.balances)
    const setCheckedRef = useRef(api.setCheckedWallets)
    const mintRef = useRef(mint)
    useEffect(() => {
        walletsRef.current = api.wallets
    })
    useEffect(() => {
        balancesRef.current = api.balances
    })
    useEffect(() => {
        setCheckedRef.current = api.setCheckedWallets
    })
    useEffect(() => {
        mintRef.current = mint
    })

    const autoCfgRef = useRef({
        buyOn: false,
        sellOn: false,
        buyCount: 1,
        buyDurationMs: 2000,
        buyMinSolLamports: BigInt(0),
        sellCount: 1,
        sellDurationMs: 2000,
        sellMinPct: 0,
    })
    useEffect(() => {
        autoCfgRef.current = {
            buyOn: autoBuyOn,
            sellOn: autoSellOn,
            buyCount: clampAutoCount(autoBuyWallets),
            buyDurationMs: clampAutoDurationMs(autoBuyDuration),
            buyMinSolLamports: parseAutoMinSol(autoBuyMinSol),
            sellCount: clampAutoCount(autoSellWallets),
            sellDurationMs: clampAutoDurationMs(autoSellDuration),
            sellMinPct: parseAutoMinPct(autoSellMinPct),
        }
    })

    /** One shared deselect timer for the roster flash (v4 scheduleDeselect). */
    const scheduleDeselect = () => {
        if (deselectTimerRef.current !== null) {
            window.clearTimeout(deselectTimerRef.current)
        }
        deselectTimerRef.current = window.setTimeout(() => {
            deselectTimerRef.current = null
            setCheckedRef.current(new Set())
        }, 5000)
    }

    const getEngine = () => {
        if (engineRef.current) return engineRef.current
        engineRef.current = makeAppConnection()
        return engineRef.current
    }

    // ------------------------------------------------------------------
    // M8A manual BUY / SELL over the CHECKED keyed wallets (lib/batch-trade)
    // ------------------------------------------------------------------
    // The "Buy / Sell" tab (FIRST managed-tabs radio, defaultChecked) runs a
    // one-click batch trade over the wallets CHECKED in the roster: Buy buys
    // buyPct% of each wallet's SPENDABLE SOL on the curve; Sell sells sellPct%
    // of each wallet's OWN token balance of the mint above. One signed tx per
    // wallet, fired concurrently (the v4 batch pattern); the report shows the
    // final counts + the confirmed signatures. Global keyboard shortcuts:
    // b/B = buy, s/S = sell (only while this tab is active: the FIRST
    // managed-tabs radio is checked), d/D = deselect (any tab). Manual trades
    // only READ the shared checked set (the auto engine flashes it too); they
    // never mutate it (only d does).

    const [buyPct, setBuyPct] = useState('95')
    const [sellPct, setSellPct] = useState('100')
    const [manualBusy, setManualBusy] = useState(false)
    const [manualError, setManualError] = useState<string | null>(null)
    const [manualReport, setManualReport] = useState<ManualBatchReport | null>(
        null
    )

    // CHECKED + keyed wallets = the manual trade selection. Recomputed every
    // render for the button-disabled guard; mirrored into selectedKeyedRef for
    // the once-registered keydown listener.
    const selectedKeyedWallets: AutoWallet[] = api.wallets
        .filter((w) => Boolean(w.key) && api.checked.has(w.address))
        .map((w) => ({ address: w.address, key: w.key as string }))
    const selectedKeyedRef = useRef<AutoWallet[]>([])
    const manualBusyRef = useRef(false)
    useEffect(() => {
        selectedKeyedRef.current = selectedKeyedWallets
    })

    // The manual engine needs the curve's creator for the buy instruction and
    // must stop when the curve is missing or already graduated (curve buy/sell
    // revert after graduation; post-graduation PumpSwap trading is the Sell
    // All button's job in the Launch card, not the manual tab's).
    const runManualTrade = async (side: 'buy' | 'sell') => {
        if (manualBusyRef.current) return
        if (!mint) {
            setManualError('ENTER A VALID TOKEN MINT ABOVE TO BUY/SELL')
            return
        }
        const wallets = selectedKeyedRef.current
        if (wallets.length === 0) {
            setManualError(
                'NO KEYED MANAGED WALLETS SELECTED (CHECK ROWS IN THE ROSTER FIRST)'
            )
            return
        }
        const pct = parseManualPct(
            side === 'buy' ? buyPct : sellPct,
            side === 'buy' ? 95 : 100
        )
        setManualBusy(true)
        manualBusyRef.current = true
        setManualError(null)
        setManualReport(null)
        try {
            const connection = getEngine()
            const mintPk = new PublicKey(mint)
            const read = await readAutoCurveState(connection, mintPk)
            if (read.kind === 'missing') {
                throw new Error('CURVE NOT FOUND FOR MINT')
            }
            if (read.curve.graduated) {
                throw new Error(
                    'CURVE GRADUATED: USE THE SELL ALL BUTTON BELOW LAUNCH (MANUAL BUY/SELL TRADES THE CURVE)'
                )
            }
            const result =
                side === 'buy'
                    ? await buySelectedWallets({
                          connection,
                          mint: mintPk,
                          curve: read.curve,
                          wallets,
                          buyPct: pct,
                      })
                    : await sellSelectedWallets({
                          connection,
                          mint: mintPk,
                          curve: read.curve,
                          wallets,
                          sellPct: pct,
                      })
            setManualReport({ side, pct, result })
            // The batch moved real balances; refresh the roster columns so the SOL /
            // token cells reflect the landed txs without waiting for the 5s poll.
            api.refreshBalances()
            const action = side === 'buy' ? 'MANUAL BUY' : 'MANUAL SELL'
            const verb = side === 'buy' ? 'BOUGHT' : 'SOLD'
            if (result.completed > 0) {
                pushToast({
                    action,
                    amount: `${result.completed} WALLET${result.completed === 1 ? '' : 'S'} ${verb}`,
                    txHash: result.signatures[0],
                })
            } else if (result.failed > 0) {
                pushToast({ action, amount: `0 ${verb}`, tone: 'error' })
            } else {
                pushToast({ action, amount: `0 ${verb} (ALL SKIPPED)` })
            }
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e)
            // M7a: rate-limit / expired blockhash / insufficient-funds / rent map
            // to actionable text instead of a raw RPC dump in the error line.
            const msg = friendlyTxError(raw)
            setManualError(msg)
            pushToast({
                action:
                    side === 'buy' ? 'MANUAL BUY FAILED' : 'MANUAL SELL FAILED',
                amount: 'TX REVERTED',
                tone: 'error',
            })
        } finally {
            manualBusyRef.current = false
            setManualBusy(false)
        }
    }

    // Latest-handler refs for the once-registered keydown listener below (the
    // listener must call the freshest closures, never a stale render's).
    const runManualBuyRef = useRef<() => void>(() => {})
    const runManualSellRef = useRef<() => void>(() => {})
    useEffect(() => {
        runManualBuyRef.current = () => void runManualTrade('buy')
        runManualSellRef.current = () => void runManualTrade('sell')
    })

    // Global keyboard shortcuts (v4 lines 504-559 port):
    //   b / B: run the Buy action (same guards as the Buy button).
    //   s / S: run the Sell action (same guards as the Sell button).
    //   d / D: deselect all checked managed wallets (works from any tab).
    // b/s fire ONLY while the Buy/Sell tab is the active radio (the FIRST
    // input[name="managed-tabs"] is checked). All three are ignored while
    // focus is in a text/number field so a shortcut never eats a character
    // mid-input (TEXTAREA, contentEditable, or an INPUT that is not
    // checkbox/radio).
    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            const key = e.key
            if (
                key !== 'b' &&
                key !== 'B' &&
                key !== 'd' &&
                key !== 'D' &&
                key !== 's' &&
                key !== 'S'
            ) {
                return
            }
            const target = e.target as HTMLElement | null
            if (target) {
                const tag = target.tagName
                if (tag === 'TEXTAREA' || target.isContentEditable) return
                if (tag === 'INPUT') {
                    const type = (target as HTMLInputElement).type
                    if (type !== 'checkbox' && type !== 'radio') return
                }
            }
            if (key === 'd' || key === 'D') {
                setCheckedRef.current(new Set())
                return
            }
            // b/s trade only from the Buy/Sell tab: it is the FIRST radio in the
            // managed-tabs group (defaultChecked).
            const radios = document.querySelectorAll<HTMLInputElement>(
                'input[name="managed-tabs"]'
            )
            if (radios.length === 0 || !radios[0].checked) return
            const wallets = selectedKeyedRef.current
            if (wallets.length === 0) return
            if (manualBusyRef.current || autoRunningRef.current) return
            if (key === 'b' || key === 'B') {
                runManualBuyRef.current()
            } else {
                runManualSellRef.current()
            }
        }
        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])

    // ------------------------------------------------------------------
    // M8C DISTRIBUTE tab: Disperse + Withdraw + Delete (lib/disperse.ts)
    // ------------------------------------------------------------------
    // The HUB is the FIRST roster wallet: disperse source + withdraw default
    // destination. Disperse funds every CHECKED wallet (address only, no key
    // needed on the receiver) from the hub in ONE hub-signed tx with a random
    // per-recipient amount in [MIN, MAX]. Withdraw sweeps every CHECKED KEYED
    // wallet (the destination excluded) to a destination the user picks in the
    // modal; each wallet signs its own tx and keeps the rent floor. Delete
    // batch-removes the CHECKED wallets whose SOL balance is below the dust
    // floor (DUST_SOL_LAMPORTS), never the hub. Per-action busy flags keep the
    // three actions independently clickable (the v4 pattern). The hub stays
    // out of every selection set defensively until the M8D roster lands its
    // unselectable-hub semantics.

    const [disperseMin, setDisperseMin] = useState('0.05')
    const [disperseMax, setDisperseMax] = useState('0.14')
    const [disperseBusy, setDisperseBusy] = useState(false)
    const [withdrawDest, setWithdrawDest] = useState('')
    const [withdrawOpen, setWithdrawOpen] = useState(false)
    const [withdrawBusy, setWithdrawBusy] = useState(false)
    const [deleteBusy, setDeleteBusy] = useState(false)
    const [distributeError, setDistributeError] = useState<string | null>(null)
    const [distributeReport, setDistributeReport] =
        useState<DistributeReport | null>(null)

    const hub = api.wallets[0] ?? null
    const hubAddr = hub?.address ?? null
    // CHECKED wallets minus the hub: disperse recipients and delete candidates.
    const selectedNonHub = api.wallets.filter(
        (w) => api.checked.has(w.address) && w.address !== hubAddr
    )

    /** Opens the Withdraw destination modal, defaulting the destination to
     *  the hub (first roster wallet) the first time it is opened. */
    const openWithdrawModal = () => {
        setWithdrawDest((prev) => (prev.trim() ? prev : (hub?.address ?? prev)))
        setWithdrawOpen(true)
    }

    const handleDisperse = async () => {
        if (disperseBusy) return
        if (!hub) {
            setDistributeError(
                'DISPERSER FAILED: NO HUB (IMPORT A WALLET FIRST)'
            )
            return
        }
        if (!hub.key) {
            setDistributeError(
                'DISPERSER FAILED: HUB HAS NO KEY (RE-ADD THE HUB SECRET IN THE ROSTER)'
            )
            return
        }
        const recipients = selectedNonHub.map((w) => w.address)
        if (recipients.length === 0) {
            setDistributeError(
                'DISPERSER FAILED: NO CHECKED WALLETS TO FUND (CHECK ROWS IN THE ROSTER)'
            )
            return
        }
        const min = parseSolInput(disperseMin)
        const max = parseSolInput(disperseMax)
        if (min === null || max === null || min > max) {
            setDistributeError(
                'DISPERSER FAILED: INVALID MIN/MAX (0 <= MIN <= MAX)'
            )
            return
        }
        setDisperseBusy(true)
        setDistributeError(null)
        setDistributeReport(null)
        try {
            const connection = makeAppConnection()
            const result = await disperseSol({
                connection,
                hub: { address: hub.address, key: hub.key },
                recipients,
                minLamports: min,
                maxLamports: max,
            })
            setDistributeReport({ kind: 'disperse', result, hub: hub.address })
            // The tx moved real SOL; refresh the roster columns immediately.
            api.refreshBalances()
            pushToast({
                action: 'DISPERSED',
                amount: `${result.count} WALLET${result.count === 1 ? '' : 'S'} · ${formatSolLamports(result.totalLamports)}`,
                txHash: result.signature,
            })
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e)
            // M7a: rate-limit / expired blockhash / insufficient-funds / rent map
            // to actionable text instead of a raw RPC dump in the error line.
            setDistributeError(`DISPERSER FAILED: ${friendlyTxError(raw)}`)
            pushToast({
                action: 'DISPERSER FAILED',
                amount: 'TX REVERTED',
                tone: 'error',
            })
        } finally {
            setDisperseBusy(false)
        }
    }

    const handleWithdraw = async () => {
        if (withdrawBusy) return
        const dest = withdrawDest.trim()
        if (!isValidPubkey(dest)) {
            setDistributeError('WITHDRAW FAILED: INVALID DESTINATION ADDRESS')
            return
        }
        const keyedSelected = selectedKeyedWallets
        // Sources = every CHECKED KEYED wallet EXCEPT the destination itself.
        const sources = keyedSelected.filter((w) => w.address !== dest)
        if (sources.length === 0) {
            setDistributeError(
                keyedSelected.length > 0
                    ? 'WITHDRAW FAILED: ALL CHECKED KEYED WALLETS ARE THE DESTINATION'
                    : 'WITHDRAW FAILED: NO KEYED WALLETS SELECTED (CHECK ROWS IN THE ROSTER)'
            )
            return
        }
        setWithdrawOpen(false)
        setWithdrawBusy(true)
        setDistributeError(null)
        setDistributeReport(null)
        try {
            const connection = makeAppConnection()
            const outcomes = await withdrawSol({
                connection,
                wallets: sources,
                dest,
                feeReserveLamports: WITHDRAW_FEE_RESERVE_LAMPORTS,
            })
            setDistributeReport({ kind: 'withdraw', dest, outcomes })
            // Every sent tx moved SOL; refresh the roster columns immediately.
            api.refreshBalances()
            const sent = outcomes.filter((o) => o.status === 'sent').length
            const failed = outcomes.filter((o) => o.status === 'failed').length
            const skipped = outcomes.filter(
                (o) => o.status === 'skipped'
            ).length
            const firstSig =
                outcomes.find((o) => o.signature)?.signature ?? null
            if (sent > 0) {
                pushToast({
                    action: 'WITHDREW',
                    amount: `${sent} WALLET${sent === 1 ? '' : 'S'} TO ${shortAddress(dest, 4)}`,
                    txHash: firstSig ?? undefined,
                })
            } else if (failed > 0) {
                pushToast({
                    action: 'WITHDRAW FAILED',
                    amount: '0 SENT',
                    tone: 'error',
                })
            } else {
                pushToast({
                    action: 'WITHDRAW',
                    amount: `0 SENT (${skipped} SKIPPED: AT RENT FLOOR)`,
                })
            }
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e)
            setDistributeError(`WITHDRAW FAILED: ${friendlyTxError(raw)}`)
            pushToast({
                action: 'WITHDRAW FAILED',
                amount: 'TX REVERTED',
                tone: 'error',
            })
        } finally {
            setWithdrawBusy(false)
        }
    }

    const handleDeleteSelected = () => {
        if (deleteBusy) return
        const sources = selectedNonHub.map((w) => w.address)
        if (sources.length === 0) {
            setDistributeError(
                'DELETE FAILED: NO CHECKED WALLETS (CHECK ROWS IN THE ROSTER)'
            )
            return
        }
        const { toDelete, skipped } = deleteEmptyWallets(
            api.wallets,
            api.balances,
            sources,
            DUST_SOL_LAMPORTS
        )
        if (toDelete.length === 0) {
            setDistributeError(null)
            setDistributeReport({
                kind: 'delete',
                removed: 0,
                skipped,
                deleted: [],
            })
            pushToast({
                action: 'DELETE: NOTHING EMPTY',
                amount:
                    skipped > 0
                        ? `${skipped} SKIPPED (FUNDED / UNKNOWN)`
                        : undefined,
                tone: 'error',
            })
            return
        }
        setDeleteBusy(true)
        setDistributeError(null)
        setDistributeReport(null)
        try {
            // Batch removal goes through the roster's per-row removeWallet
            // (Prompt D adds it to RosterApi); every address here already passed
            // the same dust gate, so each per-row remove succeeds. The optional
            // intersection keeps this file compiling while D's roster.tsx edit is
            // still landing in parallel.
            const remove = (
                api as RosterApi & { removeWallet?: (addr: string) => void }
            ).removeWallet
            if (typeof remove !== 'function') {
                throw new Error(
                    'ROSTER REMOVE API UNAVAILABLE (THE ACT-COLUMN ROSTER UPDATE HAS NOT LANDED YET; RELOAD)'
                )
            }
            for (const address of toDelete) remove(address)
            setDistributeReport({
                kind: 'delete',
                removed: toDelete.length,
                skipped,
                deleted: toDelete,
            })
            pushToast({
                action: 'DELETED',
                amount: `${toDelete.length} WALLET${toDelete.length === 1 ? '' : 'S'}${skipped > 0 ? ` · ${skipped} SKIPPED` : ''}`,
                tone: 'ok',
            })
        } catch (e) {
            const raw = e instanceof Error ? e.message : String(e)
            setDistributeError(`DELETE FAILED: ${friendlyTxError(raw)}`)
            pushToast({
                action: 'DELETE FAILED',
                amount: 'NOT REMOVED',
                tone: 'error',
            })
        } finally {
            setDeleteBusy(false)
        }
    }

    const autoRoundStatus = (label: string, r: AutoRoundResult): string => {
        const parts = [`${label}: ${r.completed} COMPLETED`]
        if (r.skipped > 0) parts.push(`${r.skipped} SKIPPED`)
        if (r.failed > 0) parts.push(`${r.failed} FAILED`)
        return parts.join(' · ')
    }

    const stopAuto = (status: string) => {
        autoRunningRef.current = false
        setAutoRunning(false)
        if (autoBuyTimerRef.current !== null) {
            window.clearTimeout(autoBuyTimerRef.current)
            autoBuyTimerRef.current = null
        }
        if (autoSellTimerRef.current !== null) {
            window.clearTimeout(autoSellTimerRef.current)
            autoSellTimerRef.current = null
        }
        autoBuyEndRef.current = null
        autoSellEndRef.current = null
        setAutoBuyLeft(null)
        setAutoSellLeft(null)
        setAutoStatus(status)
    }

    const scheduleAutoBuy = () => {
        // eslint-disable-next-line react-hooks/purity -- timer schedulers run only from setTimeout callbacks / click handlers, never during render
        autoBuyEndRef.current = Date.now() + autoCfgRef.current.buyDurationMs
        autoBuyTimerRef.current = window.setTimeout(() => {
            void autoBuyTick()
        }, autoCfgRef.current.buyDurationMs)
    }

    const scheduleAutoSell = () => {
        // eslint-disable-next-line react-hooks/purity -- timer schedulers run only from setTimeout callbacks / click handlers, never during render
        autoSellEndRef.current = Date.now() + autoCfgRef.current.sellDurationMs
        autoSellTimerRef.current = window.setTimeout(() => {
            void autoSellTick()
        }, autoCfgRef.current.sellDurationMs)
    }

    /** The curve gate for a round: reads the graduated flag (and the creator
     *  needed by the buy accounts). ok=false with `stop` halts the bot (missing
     *  or graduated curve); ok=false with `retry` reschedules (transient RPC). */
    const readRoundGate = async (
        mintPk: PublicKey
    ): Promise<{
        ok: boolean
        curve?: AutoCurveInfo
        stop?: string
        retry?: string
    }> => {
        const connection = getEngine()
        let read
        try {
            read = await readAutoCurveState(connection, mintPk)
        } catch {
            return {
                ok: false,
                retry: 'RPC ERROR READING CURVE STATE, RETRYING',
            }
        }
        if (read.kind === 'missing') {
            return { ok: false, stop: 'CURVE NOT FOUND FOR MINT' }
        }
        if (read.curve.graduated) {
            return { ok: false, stop: 'AUTO STOPPED: GRADUATED' }
        }
        return { ok: true, curve: read.curve }
    }

    async function autoBuyTick() {
        if (!autoRunningRef.current) return
        if (autoLockRef.current) {
            setAutoStatus('AUTO BUY: WAITING ON INCLUSION')
            scheduleAutoBuy()
            return
        }
        const cfg = autoCfgRef.current
        if (!cfg.buyOn) {
            scheduleAutoBuy()
            return
        }
        const mintPk = mintRef.current ? new PublicKey(mintRef.current) : null
        if (!mintPk) {
            stopAuto('NO TOKEN ADDRESS')
            return
        }
        const gate = await readRoundGate(mintPk)
        if (!autoRunningRef.current) return // stopped while the gate read
        if (!gate.ok) {
            if (gate.stop) {
                stopAuto(gate.stop)
            } else {
                setAutoStatus(gate.retry ?? '')
                scheduleAutoBuy()
            }
            return
        }
        const wallets = pickRandomKeyedWallets(
            cfg.buyCount,
            'sol',
            walletsRef.current,
            balancesRef.current,
            cfg.buyMinSolLamports,
            BigInt(0)
        )
        if (wallets.length === 0) {
            // No funded pool: silently reschedule the round (v4 behavior).
            scheduleAutoBuy()
            return
        }
        autoLockRef.current = true
        // Flash the round's picks in the roster; cleared by scheduleDeselect 5s
        // later even when the round below bails early.
        setCheckedRef.current(new Set(wallets.map((w) => w.address)))
        scheduleDeselect()
        setAutoStatus(
            `AUTO BUY: ${wallets.length} RANDOM WALLET${wallets.length === 1 ? '' : 'S'}...`
        )
        // Round-start scheduling: the next round fires the instant this round's
        // window ends, regardless of how long the build + send takes.
        scheduleAutoBuy()
        const connection = getEngine()
        void fireAutoBuy({
            connection,
            mint: mintPk,
            curve: gate.curve as AutoCurveInfo,
            wallets,
            minSolLamports: cfg.buyMinSolLamports,
        })
            .then((res) => {
                if (autoRunningRef.current) {
                    setAutoStatus(autoRoundStatus('AUTO BUY', res))
                }
            })
            .catch((e) => {
                // M7a: a top-level round failure (RPC down, blockhash fetch error)
                // must surface instead of dying as an unhandled rejection. The bot
                // stays armed: the next round is already scheduled and retries.
                if (autoRunningRef.current) {
                    const raw = e instanceof Error ? e.message : String(e)
                    setAutoStatus(
                        `AUTO BUY ROUND ERROR: ${friendlyTxError(raw)} (RETRYING NEXT ROUND)`
                    )
                }
            })
            .finally(() => {
                autoLockRef.current = false
            })
    }

    async function autoSellTick() {
        if (!autoRunningRef.current) return
        if (autoLockRef.current) {
            setAutoStatus('AUTO SELL: WAITING ON INCLUSION')
            scheduleAutoSell()
            return
        }
        const cfg = autoCfgRef.current
        if (!cfg.sellOn) {
            scheduleAutoSell()
            return
        }
        const mintPk = mintRef.current ? new PublicKey(mintRef.current) : null
        if (!mintPk) {
            stopAuto('NO TOKEN ADDRESS')
            return
        }
        const gate = await readRoundGate(mintPk)
        if (!autoRunningRef.current) return
        if (!gate.ok) {
            if (gate.stop) {
                stopAuto(gate.stop)
            } else {
                setAutoStatus(gate.retry ?? '')
                scheduleAutoSell()
            }
            return
        }
        const minSellRaw = autoSellMinRaw(cfg.sellMinPct)
        const wallets = pickRandomKeyedWallets(
            cfg.sellCount,
            'token',
            walletsRef.current,
            balancesRef.current,
            BigInt(0),
            minSellRaw
        )
        if (wallets.length === 0) {
            scheduleAutoSell()
            return
        }
        autoLockRef.current = true
        setCheckedRef.current(new Set(wallets.map((w) => w.address)))
        scheduleDeselect()
        setAutoStatus(
            `AUTO SELL: ${wallets.length} RANDOM WALLET${wallets.length === 1 ? '' : 'S'}...`
        )
        scheduleAutoSell()
        const connection = getEngine()
        void fireAutoSell({
            connection,
            mint: mintPk,
            curve: gate.curve as AutoCurveInfo,
            wallets,
            minSellRaw,
        })
            .then((res) => {
                if (autoRunningRef.current) {
                    setAutoStatus(autoRoundStatus('AUTO SELL', res))
                }
            })
            .catch((e) => {
                // M7a: surface a top-level round failure instead of an unhandled
                // rejection; the next round is already scheduled and retries.
                if (autoRunningRef.current) {
                    const raw = e instanceof Error ? e.message : String(e)
                    setAutoStatus(
                        `AUTO SELL ROUND ERROR: ${friendlyTxError(raw)} (RETRYING NEXT ROUND)`
                    )
                }
            })
            .finally(() => {
                autoLockRef.current = false
            })
    }

    const handleStartAuto = async () => {
        if (autoRunningRef.current) return
        const cfg = autoCfgRef.current
        if (!mintRef.current) {
            setAutoStatus('NO TOKEN ADDRESS')
            return
        }
        if (!cfg.buyOn && !cfg.sellOn) {
            setAutoStatus('ENABLE AUTO BUY OR AUTO SELL FIRST')
            return
        }
        if (walletsRef.current.filter((w) => w.key).length === 0) {
            setAutoStatus('NO KEYED WALLETS IN ROSTER')
            return
        }
        const gate = await readRoundGate(new PublicKey(mintRef.current))
        if (gate.ok === false) {
            setAutoStatus(gate.stop ?? gate.retry ?? 'CANNOT START')
            return
        }
        autoRunningRef.current = true
        setAutoRunning(true)
        const parts: string[] = []
        if (cfg.buyOn)
            parts.push(`BUY EVERY ${Math.round(cfg.buyDurationMs / 1000)}S`)
        if (cfg.sellOn)
            parts.push(`SELL EVERY ${Math.round(cfg.sellDurationMs / 1000)}S`)
        setAutoStatus(`AUTO RUNNING · ${parts.join(' · ')}`)
        // First rounds fire immediately, then every duration (v4 round-start).
        if (cfg.buyOn) {
            autoBuyEndRef.current = Date.now() + cfg.buyDurationMs
            void autoBuyTick()
        }
        if (cfg.sellOn) {
            autoSellEndRef.current = Date.now() + cfg.sellDurationMs
            void autoSellTick()
        }
    }

    const handleStopAuto = () => {
        stopAuto('AUTO STOPPED')
    }

    // Live countdown readouts from the round-end timestamps (purely visual;
    // the cadence itself stays with the recursive timers).
    useEffect(() => {
        if (!autoRunning) return
        const id = window.setInterval(() => {
            const now = Date.now()
            setAutoBuyLeft(
                autoBuyEndRef.current === null
                    ? null
                    : Math.max(
                          0,
                          Math.ceil((autoBuyEndRef.current - now) / 1000)
                      )
            )
            setAutoSellLeft(
                autoSellEndRef.current === null
                    ? null
                    : Math.max(
                          0,
                          Math.ceil((autoSellEndRef.current - now) / 1000)
                      )
            )
        }, 250)
        return () => window.clearInterval(id)
    }, [autoRunning])

    // Unmount safety: never let a scheduled auto tick or the deselect timer
    // outlive the component.
    useEffect(() => {
        return () => {
            autoRunningRef.current = false
            if (autoBuyTimerRef.current !== null) {
                window.clearTimeout(autoBuyTimerRef.current)
            }
            if (autoSellTimerRef.current !== null) {
                window.clearTimeout(autoSellTimerRef.current)
            }
            if (deselectTimerRef.current !== null) {
                window.clearTimeout(deselectTimerRef.current)
            }
        }
    }, [])

    return (
        <Card
            head={
                <div className="flex items-center justify-between">
                    <span className="label-mono !text-[13px]">Trade</span>
                </div>
            }
            className="flex-1">
            <div className="flex flex-col gap-4">
                <div className="sticky top-0 z-30 flex flex-col gap-4 bg-paper">
                    {/* Token identity header: the curve mint's square image beside the
          token-address input; the field aside shows the on-chain name +
          symbol (from the Token-2022 in-mint metadata) once they load. */}
                    <div className="flex items-start gap-3">
                        {/*mint ? (
              <TokenSquare
                key={mint}
                meta={tokenMeta}
                metaJson={tokenJson}
                metaStatus={metaStatus}
              />
            ) : null*/}
                        <div className="min-w-0 flex-1">
                            <Field
                                label="Token Address"
                                aside={
                                    mint ? (
                                        tokenMeta ? (
                                            <span
                                                title={`${tokenMeta.name} (${tokenMeta.symbol}) · ${mint}`}
                                                className="truncate">
                                                {tokenMeta.name} (
                                                {tokenMeta.symbol})
                                            </span>
                                        ) : metaStatus === 'loading' ? (
                                            <span title={mint}>
                                                READING TOKEN META...
                                            </span>
                                        ) : (
                                            <span>{shortAddress(mint, 6)}</span>
                                        )
                                    ) : undefined
                                }>
                                <Input
                                    value={tokenAddr}
                                    onChange={(e) =>
                                        onTokenAddrChange(e.target.value)
                                    }
                                    placeholder="BASE58... (MINT)"
                                    className={inputCls}
                                    spellCheck={false}
                                />
                            </Field>
                        </div>
                    </div>

                    {/* All available socials in one horizontal row: from the metadata
          JSON at the on-chain uri (nothing renders while none exist). */}
                    {mint ? <TokenSocials metaJson={tokenJson} /> : null}

                    {trimmed && !mint ? (
                        <StatusLine
                            text="NOT A VALID SOLANA MINT ADDRESS. THE ROSTER TOKEN COLUMN STAYS OFF"
                            tone="idle"
                        />
                    ) : null}

                    <div className="border-t-2 border-ink pt-3">
                        {/* trade for managed wallets: the roster of keys (1440h rolling
            expiry) with checkbox-batch selection lives below the tabs. */}
                        <span className="label-mono !text-[11px]">
                            Trade For Managed Wallets
                        </span>
                        <div
                            role="tablist"
                            aria-label="Managed wallet actions"
                            className="tabs-lift mt-2">
                            {/* ---- Buy / Sell (M8A: FIRST tab + defaultChecked so the
              b/s keyboard shortcuts fire here; moves the M4 manual
              buy/sell omission back in) ---- */}
                            <label
                                role="tab"
                                aria-label="Buy / Sell"
                                className="tab">
                                <input
                                    type="radio"
                                    name="managed-tabs"
                                    className="sr-only"
                                    defaultChecked
                                />
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="square"
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true">
                                    <path d="M8 3 4 7l4 4" />
                                    <path d="M4 7h16" />
                                    <path d="M16 21l4-4-4-4" />
                                    <path d="M20 17H4" />
                                </svg>
                                Buy/Sell
                            </label>
                            <div role="tabpanel" className="tab-content">
                                {/* Manual batch trade (M8A): the v4 Buy/Sell grid - one row,
                five cells, no labels or borders. Cell 1 is the roster batch
                size; Buy spends buyPct% of each CHECKED keyed wallet's
                spendable SOL on the curve, Sell sells sellPct% of each
                wallet's own token balance (lib/batch-trade.ts, one signed
                tx per wallet, concurrent). The buttons disable while the
                M5 auto bot runs or nothing is selected. */}
                                <div className="mt-2 grid gap-2 md:grid-cols-5 [auto_1fr_1fr]">
                                    <div className="flex items-center gap-2">
                                        <Input
                                            type="number"
                                            min="0"
                                            max={api.wallets.length}
                                            value={api.batchSize}
                                            onChange={(e) =>
                                                api.setBatchSize(e.target.value)
                                            }
                                            className="w-8 text-center font-mono text-[12px] border-none"
                                        />
                                    </div>
                                    <div className="flex items-center gap-1">
                                        <Input
                                            type="number"
                                            step="1"
                                            min="1"
                                            max="100"
                                            value={buyPct}
                                            onChange={(e) =>
                                                setBuyPct(e.target.value)
                                            }
                                            aria-label="Buy percentage"
                                            className="w-14 text-center font-mono text-[12px] border-none"
                                        />
                                        <span className="label-mono text-[10px] opacity-60">
                                            %
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className="btn-brutal h-full shadow-none!"
                                        onClick={() =>
                                            void runManualTrade('buy')
                                        }
                                        disabled={
                                            manualBusy ||
                                            autoRunning ||
                                            !mint ||
                                            selectedKeyedWallets.length === 0
                                        }>
                                        Buy {buyPct || 95}%
                                    </button>
                                    <div className="flex items-center gap-1">
                                        <Input
                                            type="number"
                                            step="1"
                                            min="1"
                                            max="100"
                                            value={sellPct}
                                            onChange={(e) =>
                                                setSellPct(e.target.value)
                                            }
                                            aria-label="Sell percentage"
                                            className="w-14 text-center font-mono text-[12px] border-none"
                                        />
                                        <span className="label-mono text-[10px] opacity-60">
                                            %
                                        </span>
                                    </div>
                                    <button
                                        type="button"
                                        className="btn-brutal btn-brutal-invert h-full shadow-none!"
                                        onClick={() =>
                                            void runManualTrade('sell')
                                        }
                                        disabled={
                                            manualBusy ||
                                            autoRunning ||
                                            !mint ||
                                            selectedKeyedWallets.length === 0
                                        }>
                                        Sell {sellPct || 100}%
                                    </button>
                                </div>
                                {manualError ? (
                                    <StatusLine
                                        text={`MANUAL TRADE FAILED: ${manualError}`}
                                        tone="error"
                                    />
                                ) : null}
                                {manualReport ? (
                                    <ManualReportView report={manualReport} />
                                ) : null}
                            </div>

                            {/* ---- Auto ---- */}
                            <label role="tab" aria-label="Auto" className="tab">
                                <input
                                    type="radio"
                                    name="managed-tabs"
                                    className="sr-only"
                                />
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="currentColor"
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true">
                                    <path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z" />
                                </svg>
                                Auto
                            </label>
                            <div role="tabpanel" className="tab-content">
                                {/* Auto: two rows (auto buy / auto sell), each a checkbox +
                label + MIN SOL/% and wallet count + duration inputs side by
                side with a live "seconds left" readout, mirroring v4's exact
                wording. Start/Stop drive the M5 scheduler; exactly one shows
                the pressed face at any time. */}
                                <div className="flex flex-col gap-2">
                                    <div className="flex items-center gap-2 border-2 border-ink px-2 py-1.5">
                                        <input
                                            type="checkbox"
                                            className="checkbox-brutal shrink-0"
                                            checked={autoBuyOn}
                                            onChange={(e) =>
                                                setAutoBuyOn(e.target.checked)
                                            }
                                            aria-label="Auto buy enabled"
                                        />
                                        <span className="label-mono !text-[10px] shrink-0">
                                            Auto Buy
                                        </span>
                                        <Input
                                            type="number"
                                            min="0"
                                            step="0.001"
                                            value={autoBuyMinSol}
                                            onChange={(e) =>
                                                setAutoBuyMinSol(e.target.value)
                                            }
                                            placeholder="MIN SOL"
                                            aria-label="Auto buy min SOL"
                                            title="Skip wallets with less than this SOL balance"
                                            className="w-20 text-center font-mono text-[11px] py-1"
                                        />
                                        <Input
                                            type="number"
                                            min="0"
                                            value={autoBuyWallets}
                                            onChange={(e) =>
                                                setAutoBuyWallets(
                                                    e.target.value
                                                )
                                            }
                                            placeholder="WALLET COUNT"
                                            aria-label="Auto buy wallet count"
                                            className="w-24 text-center font-mono text-[11px] py-1"
                                        />
                                        <Input
                                            type="number"
                                            min="0"
                                            value={autoBuyDuration}
                                            onChange={(e) =>
                                                setAutoBuyDuration(
                                                    e.target.value
                                                )
                                            }
                                            placeholder="DURATION"
                                            aria-label="Auto buy duration"
                                            title="Seconds between buy rounds"
                                            className="w-20 text-center font-mono text-[11px] py-1"
                                        />
                                        <span className="label-mono !text-[10px] shrink-0 w-9 text-right tabular-nums">
                                            {autoBuyOn &&
                                            autoRunning &&
                                            autoBuyLeft !== null
                                                ? `${autoBuyLeft}s`
                                                : ''}
                                        </span>
                                    </div>
                                    <div className="flex items-center gap-2 border-2 border-ink px-2 py-1.5">
                                        <input
                                            type="checkbox"
                                            className="checkbox-brutal shrink-0"
                                            checked={autoSellOn}
                                            onChange={(e) =>
                                                setAutoSellOn(e.target.checked)
                                            }
                                            aria-label="Auto sell enabled"
                                        />
                                        <span className="label-mono !text-[10px] shrink-0">
                                            Auto Sell
                                        </span>
                                        <Input
                                            type="number"
                                            min="0"
                                            max="100"
                                            value={autoSellMinPct}
                                            onChange={(e) =>
                                                setAutoSellMinPct(
                                                    e.target.value
                                                )
                                            }
                                            placeholder="%"
                                            aria-label="Auto sell min percent"
                                            title="Skip wallets holding below MIN % of the total supply (0 = off)"
                                            className="w-14 text-center font-mono text-[11px] py-1"
                                        />
                                        <Input
                                            type="number"
                                            min="0"
                                            value={autoSellWallets}
                                            onChange={(e) =>
                                                setAutoSellWallets(
                                                    e.target.value
                                                )
                                            }
                                            placeholder="WALLET COUNT"
                                            aria-label="Auto sell wallet count"
                                            className="w-24 text-center font-mono text-[11px] py-1"
                                        />
                                        <Input
                                            type="number"
                                            min="0"
                                            value={autoSellDuration}
                                            onChange={(e) =>
                                                setAutoSellDuration(
                                                    e.target.value
                                                )
                                            }
                                            placeholder="DURATION"
                                            aria-label="Auto sell duration"
                                            title="Seconds between sell rounds"
                                            className="w-20 text-center font-mono text-[11px] py-1"
                                        />
                                        <span className="label-mono !text-[10px] shrink-0 w-9 text-right tabular-nums">
                                            {autoSellOn &&
                                            autoRunning &&
                                            autoSellLeft !== null
                                                ? `${autoSellLeft}s`
                                                : ''}
                                        </span>
                                    </div>
                                    <div className="mt-1 flex gap-2 border-t-2 border-ink pt-2">
                                        <Btn
                                            onClick={() =>
                                                void handleStartAuto()
                                            }
                                            disabled={autoRunning}
                                            pressed={autoRunning}
                                            className="flex-1 shadow-none!">
                                            Start
                                        </Btn>
                                        <Btn
                                            onClick={handleStopAuto}
                                            disabled={!autoRunning}
                                            pressed={!autoRunning}
                                            className="flex-1 shadow-none!">
                                            Stop
                                        </Btn>
                                    </div>
                                    {autoStatus ? (
                                        <StatusLine
                                            text={autoStatus}
                                            tone="idle"
                                        />
                                    ) : null}
                                </div>
                            </div>

                            {/* ---- Distribute (M8C): disperse / withdraw / delete ---- */}
                            <label
                                role="tab"
                                aria-label="Distribute"
                                className="tab">
                                <input
                                    type="radio"
                                    name="managed-tabs"
                                    className="sr-only"
                                />
                                <svg
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2.5"
                                    strokeLinecap="square"
                                    className="h-3.5 w-3.5"
                                    aria-hidden="true">
                                    <path d="M12 4v16" />
                                    <path d="m12 4-3 3" />
                                    <path d="m12 4 3 3" />
                                    <path d="m12 20-3-3" />
                                    <path d="m12 20 3-3" />
                                </svg>
                                Distribute
                            </label>
                            <div role="tabpanel" className="tab-content">
                                {/* Distribute (M8C): the key-ADD row (input + Add + Random,
                roster import) lives in this tab, then the disperse /
                withdraw / delete grid. Disperse funds every CHECKED wallet
                (address only, no key needed) from the HUB (first roster
                wallet) in ONE hub-signed tx, a random lamport amount in
                [MIN, MAX] per wallet. Withdraw sweeps every CHECKED KEYED
                wallet to the modal destination (default hub); each wallet
                signs its own tx and keeps the rent floor. Delete
                batch-removes the CHECKED wallets whose SOL is below
                DUST_SOL_LAMPORTS; the hub is never deletable. */}
                                <div className="flex w-full gap-2">
                                    <Input
                                        type="text"
                                        autoComplete="off"
                                        spellCheck={false}
                                        value={api.importText}
                                        onChange={(e) =>
                                            api.setImportText(e.target.value)
                                        }
                                        onKeyDown={(e) => {
                                            if (e.key === 'Enter')
                                                api.handleImport()
                                        }}
                                        placeholder="BASE58... PRIVATE KEY(S) · NEW LINE / COMMA"
                                        className="font-mono text-[12px] flex-1 w-full h-11"
                                    />
                                    <button
                                        type="button"
                                        className="btn-brutal h-11 shadow-none!"
                                        onClick={api.handleImport}>
                                        Add
                                    </button>
                                    <Input
                                        type="number"
                                        min="1"
                                        value={api.randomCount}
                                        onChange={(e) =>
                                            api.setRandomCount(e.target.value)
                                        }
                                        placeholder="N"
                                        aria-label="Random wallet count"
                                        className="size-11! text-center font-mono text-[11px] py-1"
                                    />
                                    <button
                                        type="button"
                                        className="btn-brutal h-11 shadow-none!"
                                        onClick={api.handleRandom}>
                                        Random
                                    </button>
                                </div>
                                {api.importError ? (
                                    <p className="label-mono text-[10px] font-bold mt-1">
                                        {api.importError}
                                    </p>
                                ) : null}
                                <div className="mt-2 grid grid-cols-2 gap-2 md:grid-cols-5">
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.001"
                                        value={disperseMin}
                                        onChange={(e) =>
                                            setDisperseMin(e.target.value)
                                        }
                                        placeholder="MIN"
                                        aria-label="Disperse minimum"
                                        className="font-mono text-[12px]"
                                    />
                                    <Input
                                        type="number"
                                        min="0"
                                        step="0.001"
                                        value={disperseMax}
                                        onChange={(e) =>
                                            setDisperseMax(e.target.value)
                                        }
                                        placeholder="MAX"
                                        aria-label="Disperse maximum"
                                        className="font-mono text-[12px]"
                                    />
                                    <Btn
                                        onClick={() => void handleDisperse()}
                                        disabled={
                                            disperseBusy ||
                                            autoRunning ||
                                            !hub?.key ||
                                            selectedNonHub.length === 0
                                        }
                                        className="h-full shadow-none!">
                                        Disperse {disperseMin || '0'}–
                                        {disperseMax || '0'} SOL
                                    </Btn>
                                    <Btn
                                        invert
                                        onClick={openWithdrawModal}
                                        disabled={
                                            withdrawBusy ||
                                            autoRunning ||
                                            selectedKeyedWallets.length === 0
                                        }
                                        className="h-full shadow-none!">
                                        Withdraw
                                    </Btn>
                                    <Btn
                                        onClick={() =>
                                            void handleDeleteSelected()
                                        }
                                        disabled={
                                            deleteBusy ||
                                            autoRunning ||
                                            selectedNonHub.length === 0
                                        }
                                        className="h-full shadow-none!">
                                        Delete
                                    </Btn>
                                </div>
                                {distributeError ? (
                                    <StatusLine
                                        text={distributeError}
                                        tone="error"
                                    />
                                ) : null}
                                {distributeReport ? (
                                    <DistributeReportView
                                        report={distributeReport}
                                    />
                                ) : null}
                                {hub ? (
                                    <p className="label-mono text-[10px] opacity-60 mt-1">
                                        VIA {shortAddress(hub.address, 6)} —
                                        DISPERSER · WITHDRAW DEFAULT DEST
                                        {hub.key
                                            ? ''
                                            : ' · NO KEY — RE-ADD TO DISPERSE'}
                                    </p>
                                ) : null}
                            </div>
                        </div>
                    </div>
                </div>

                {/* Without-key skip banner (v4 placement): directly below the
        managed-wallet tabs, above the roster table. Shown when the CHECKED
        selection includes wallets with no key (they are skipped by every
        keyed action: buy/sell, disperse/withdraw sources, sell all). */}
                {api.selectedCount > selectedKeyedWallets.length ? (
                    <p className="label-mono text-[10px] opacity-60 mt-1">
                        {api.selectedCount - selectedKeyedWallets.length} WALLET
                        {api.selectedCount - selectedKeyedWallets.length === 1
                            ? ''
                            : 'S'}{' '}
                        WITHOUT KEY SKIPPED (RE-ADD KEY TO RESTORE)
                    </p>
                ) : null}

                <Roster api={api} />

                {/* M8C Withdraw destination modal (v4 mirror): opened from the
        Distribute tab's Withdraw button with the destination defaulted to
        the hub (first roster wallet); the user may change it. Withdraw
        sweeps the CHECKED KEYED wallets (the destination is never a
        source). Cancel closes without sending. */}
                {withdrawOpen ? (
                    <div
                        role="dialog"
                        aria-modal="true"
                        aria-label="Withdraw to destination address"
                        className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/60 p-4"
                        onClick={() => setWithdrawOpen(false)}>
                        <div
                            className="card-brutal relative w-full max-w-sm bg-paper p-4"
                            onClick={(e) => e.stopPropagation()}>
                            <button
                                type="button"
                                aria-label="Close withdraw"
                                className="label-mono absolute right-2 top-2 p-1 text-[14px] opacity-60 hover:opacity-100"
                                onClick={() => setWithdrawOpen(false)}>
                                ×
                            </button>
                            <span className="label-mono block text-center !text-[13px]">
                                Withdraw
                            </span>
                            <div className="mt-3">
                                <label className="label-mono block !text-[11px]">
                                    To
                                </label>
                                <Input
                                    type="text"
                                    autoComplete="off"
                                    spellCheck={false}
                                    value={withdrawDest}
                                    onChange={(e) =>
                                        setWithdrawDest(e.target.value)
                                    }
                                    placeholder="BASE58... (WITHDRAW DESTINATION)"
                                    className="mt-1 font-mono text-[12px]"
                                />

                                {withdrawDest.trim() &&
                                !isValidPubkey(withdrawDest.trim()) ? (
                                    <p className="label-mono mt-1 text-[10px] font-bold">
                                        NOT A VALID BASE58 ADDRESS
                                    </p>
                                ) : null}
                            </div>
                            <div className="mt-3 flex gap-2">
                                <Btn
                                    invert
                                    className="flex-1"
                                    onClick={() => setWithdrawOpen(false)}>
                                    Cancel
                                </Btn>
                                <Btn
                                    className="flex-1"
                                    onClick={() => void handleWithdraw()}
                                    disabled={
                                        withdrawBusy ||
                                        selectedKeyedWallets.length === 0
                                    }>
                                    {withdrawBusy ? 'Sweeping...' : 'Withdraw'}
                                </Btn>
                            </div>
                            {withdrawBusy ? (
                                <div className="mt-2">
                                    <StatusLine
                                        text="SWEEPING CHECKED KEYED WALLETS (CONCURRENT, ONE TX PER WALLET)..."
                                        tone="idle"
                                    />
                                </div>
                            ) : null}
                        </div>
                    </div>
                ) : null}
            </div>
        </Card>
    )
}

/* ---------- M8A manual buy/sell report (counts + signatures) ---------- */

/** A finished manual batch trade, ready for the report view. */
interface ManualBatchReport {
    side: 'buy' | 'sell'
    pct: number
    result: ManualBatchResult
}

/** Buy/Sell % input parse: blank/invalid/non-positive -> the fallback
 *  default (95 buy / 100 sell); a value above 100 clamps to 100. Mirrors
 *  v4's Buy {pct}% / Sell {pct}% labels so the button always shows exactly
 *  the percentage the engine will use. */
function parseManualPct(raw: string, fallback: number): number {
    const trimmed = raw.trim()
    if (!trimmed) return fallback
    const n = Number(trimmed)
    if (!Number.isFinite(n) || n <= 0) return fallback
    return Math.min(100, n)
}

/** Compact per-batch report: side + pct headline, then each confirmed
 *  signature as an ExplorerLink (the v4 batch pattern wording). */
function ManualReportView({ report }: { report: ManualBatchReport }) {
    const { side, pct, result } = report
    const verb = side === 'buy' ? 'BOUGHT' : 'SOLD'
    const total = result.completed + result.skipped + result.failed
    return (
        <div className="flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
            <p className="label-mono !text-[11px] font-bold">
                {side === 'buy' ? 'BUY' : 'SELL'} {pct}%: {verb}{' '}
                {result.completed}/{total} · SKIPPED {result.skipped} · FAILED{' '}
                {result.failed}
            </p>
            {result.signatures.length > 0 ? (
                <div className="flex flex-col gap-0.5 border-t border-ink/40 pt-1">
                    {result.signatures.map((sig) => (
                        <p
                            key={sig}
                            className="label-mono !text-[10px] break-all opacity-90">
                            TX <ExplorerLink hash={sig} />
                        </p>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

/* ---------- M8C distribute report (last action's outcome) ---------- */

/** A finished Distribute-tab action, ready for the report view (the Sell
 *  All tab's per-wallet report pattern, one report per action kind). */
type DistributeReport =
    | { kind: 'disperse'; result: DisperseResult; hub: string }
    | { kind: 'withdraw'; dest: string; outcomes: WithdrawOutcome[] }
    | { kind: 'delete'; removed: number; skipped: number; deleted: string[] }

/** SOL amount input parse (Disperse MIN/MAX): a blank field is 0; a
 *  non-numeric or negative value is invalid (null). Converts the decimal
 *  SOL string to whole lamports via LAMPORTS_PER_SOL. */
function parseSolInput(raw: string): bigint | null {
    const n = Number(raw.trim())
    if (!Number.isFinite(n) || n < 0) return null
    return BigInt(Math.round(n * LAMPORTS_PER_SOL))
}

/** Compact per-action report: headline counts + per-wallet rows for
 *  withdraw, signature + total for disperse, removed list for delete. */
function DistributeReportView({ report }: { report: DistributeReport }) {
    if (report.kind === 'disperse') {
        const { result, hub } = report
        return (
            <div className="flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
                <p className="label-mono !text-[11px] font-bold break-all">
                    DISPERSED {result.count} WALLET
                    {result.count === 1 ? '' : 'S'} ·{' '}
                    {formatSolLamports(result.totalLamports)} FROM HUB{' '}
                    {shortAddress(hub, 6)}
                </p>
                <p className="label-mono !text-[10px] break-all opacity-90">
                    ONE TX <ExplorerLink hash={result.signature} />
                </p>
            </div>
        )
    }
    if (report.kind === 'withdraw') {
        const { dest, outcomes } = report
        const sent = outcomes.filter((o) => o.status === 'sent').length
        const failed = outcomes.filter((o) => o.status === 'failed').length
        const skipped = outcomes.filter((o) => o.status === 'skipped').length
        return (
            <div className="flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
                <p className="label-mono !text-[11px] font-bold break-all">
                    WITHDREW {sent}/{outcomes.length} TO {shortAddress(dest, 6)}{' '}
                    · SKIPPED {skipped} · FAILED {failed}
                </p>
                {outcomes.length > 0 ? (
                    <div className="flex flex-col gap-0.5">
                        {outcomes.map((o) => (
                            <WithdrawOutcomeRow key={o.address} outcome={o} />
                        ))}
                    </div>
                ) : null}
            </div>
        )
    }
    const { removed, skipped, deleted } = report
    return (
        <div className="flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
            <p className="label-mono !text-[11px] font-bold">
                DELETE: REMOVED {removed} · SKIPPED {skipped} (NOT EMPTY /
                UNKNOWN BALANCE)
            </p>
            {deleted.length > 0 ? (
                <div className="flex flex-col gap-0.5 border-t border-ink/40 pt-1">
                    {deleted.map((address) => (
                        <p
                            key={address}
                            className="label-mono !text-[10px] break-all opacity-90">
                            {shortAddress(address, 6)} REMOVED
                        </p>
                    ))}
                </div>
            ) : null}
        </div>
    )
}

function WithdrawOutcomeRow({ outcome }: { outcome: WithdrawOutcome }) {
    const addr = shortAddress(outcome.address, 6)
    let body
    if (outcome.status === 'sent') {
        body = (
            <span>
                WITHDREW {formatSolLamports(outcome.solWithdrawn)}
                {outcome.signature ? (
                    <span className="ml-1">
                        <ExplorerLink hash={outcome.signature} />
                    </span>
                ) : null}
            </span>
        )
    } else if (outcome.status === 'skipped') {
        body = <span>SKIPPED ({outcome.reason ?? 'at rent floor'})</span>
    } else {
        body = <span>FAILED ({outcome.reason ?? 'error'})</span>
    }
    return (
        <p className="label-mono !text-[10px] break-all opacity-90">
            {addr} {body}
        </p>
    )
}

/* ---------- token identity header (image, name/symbol, socials) ---------- */

/** The mint's Token-2022 in-mint metadata (create_v2 stores name/symbol/uri
 *  IN THE MINT, read by readToken2022Metadata). */
interface TokenIdentity {
    name: string
    symbol: string
    uri: string
}

/** Metadata read lifecycle for the header square + aside. */
type MetaStatus = 'idle' | 'loading' | 'ok' | 'error'

/** Off-chain fields extracted from the metadata JSON at the on-chain uri
 *  (pump.fun-style keys: image / website / external_url / twitter /
 *  telegram; empty values are omitted from the JSON, never ""). */
interface TokenMetaJson {
    image?: string
    twitter?: string
    telegram?: string
    website?: string
}

/** One metadata read's full result, stamped with the mint it was read for so
 *  a stale async result can never paint over a different mint's header. */
interface TokenHeaderInfo {
    mint: string
    meta: TokenIdentity | null
    json: TokenMetaJson | null
    status: MetaStatus
}

/** Best-effort fetch of the metadata JSON: null when the uri is unreachable,
 *  not JSON, or the body carries none of the tracked fields. The image and
 *  socials stay optional so a partial read still renders what it got. */
async function readTokenMetaJson(uri: string): Promise<TokenMetaJson | null> {
    try {
        const res = await fetch(uri)
        if (!res.ok) return null
        const j: unknown = await res.json()
        if (typeof j !== 'object' || j === null) return null
        const rec = j as Record<string, unknown>
        const str = (k: string): string | undefined =>
            typeof rec[k] === 'string' && (rec[k] as string).trim() !== ''
                ? (rec[k] as string).trim()
                : undefined
        return {
            image: str('image'),
            twitter: str('twitter'),
            telegram: str('telegram'),
            website: str('website') ?? str('external_url'),
        }
    } catch {
        return null
    }
}

/** Social raw value -> a clickable href. Bare handles / hostnames get the
 *  service scheme; full URLs pass through untouched. */
function socialHref(
    kind: 'twitter' | 'telegram' | 'website',
    raw: string
): string {
    const v = raw.trim()
    if (/^https?:\/\//i.test(v)) return v
    if (kind === 'twitter') return `https://x.com/${v.replace(/^@/, '')}`
    if (kind === 'telegram') return `https://t.me/${v.replace(/^@/, '')}`
    return `https://${v}`
}

/** Display label for a social row item: @handle for X / Telegram, the
 *  hostname (no www) for a website. */
function socialLabel(
    kind: 'twitter' | 'telegram' | 'website',
    raw: string
): string {
    const v = raw.trim()
    if (kind === 'website') {
        const withScheme = /^https?:\/\//i.test(v) ? v : `https://${v}`
        try {
            return new URL(withScheme).hostname.replace(/^www\./, '')
        } catch {
            return v
        }
    }
    if (/^https?:\/\//i.test(v)) {
        const segs = v
            .replace(/^https?:\/\//i, '')
            .split(/[/?#]/)
            .filter(Boolean)
        const last = segs[segs.length - 1]
        return segs.length >= 2 && last ? `@${last}` : `@${segs[0] ?? ''}`
    }
    return `@${v.replace(/^@/, '')}`
}

/** 48px square for the curve mint: the token's off-chain image when one is
 *  published, else a symbol-letter plate. The broken-image fallback keeps a
 *  dead URL from leaving a broken-glyph frame; parent keys the instance by
 *  mint so a new token remounts clean. */
function TokenSquare({
    meta,
    metaJson,
    metaStatus,
}: {
    meta: TokenIdentity | null
    metaJson: TokenMetaJson | null
    metaStatus: MetaStatus
}) {
    const [broken, setBroken] = useState(false)
    const imageUrl = metaJson?.image
    return (
        <div
            className="flex h-12 w-12 shrink-0 items-center justify-center overflow-hidden border-2 border-ink bg-paper"
            title={
                meta
                    ? `${meta.name} (${meta.symbol})`
                    : metaStatus === 'loading'
                      ? 'READING TOKEN META...'
                      : 'NO ON-CHAIN TOKEN METADATA'
            }>
            {imageUrl && !broken ? (
                // eslint-disable-next-line @next/next/no-img-element -- token images come from arbitrary on-chain metadata URLs; next/image optimization does not apply
                <img
                    src={imageUrl}
                    alt={meta ? `${meta.symbol} token image` : 'TOKEN IMAGE'}
                    referrerPolicy="no-referrer"
                    className="h-full w-full object-cover"
                    onError={() => setBroken(true)}
                />
            ) : (
                <span className="label-mono text-[12px] opacity-70">
                    {meta
                        ? meta.symbol.slice(0, 4)
                        : metaStatus === 'loading'
                          ? '...'
                          : '?'}
                </span>
            )}
        </div>
    )
}

/** Horizontal socials row (X / Telegram / website) read from the off-chain
 *  metadata JSON; renders nothing when the JSON has none. */
function TokenSocials({ metaJson }: { metaJson: TokenMetaJson | null }) {
    const items: {
        kind: 'X' | 'TG' | 'WEB'
        href: string
        label: string
    }[] = []
    if (metaJson?.twitter) {
        items.push({
            kind: 'X',
            href: socialHref('twitter', metaJson.twitter),
            label: socialLabel('twitter', metaJson.twitter),
        })
    }
    if (metaJson?.telegram) {
        items.push({
            kind: 'TG',
            href: socialHref('telegram', metaJson.telegram),
            label: socialLabel('telegram', metaJson.telegram),
        })
    }
    if (metaJson?.website) {
        items.push({
            kind: 'WEB',
            href: socialHref('website', metaJson.website),
            label: socialLabel('website', metaJson.website),
        })
    }
    if (items.length === 0) return null
    return (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 border-t-2 border-ink/40 pt-2">
            {items.map((it) => (
                <a
                    key={it.kind}
                    href={it.href}
                    target="_blank"
                    rel="noreferrer"
                    className="label-mono text-[10px] underline decoration-2 underline-offset-2 hover:opacity-60">
                    {it.kind} {it.label}
                </a>
            ))}
        </div>
    )
}
