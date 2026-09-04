'use client'

// Milestone M4: managed-wallet roster (ported from v4-launchpad).
//
// Checkbox-only selection, exactly like v4: rows never toggle selection,
// only the checkbox does. The header checkbox is toggleAll; a row checkbox
// toggles a BATCH anchored at that row (batch size input, default 2), so
// successive clicks build up 2 + 2 + 2. The pubkey cell is a click-to-copy
// button. Keys are imported as base58 64-byte secrets (88 chars) and
// persisted with the 1440h rolling TTL from lib/managed-wallets.ts.
//
// Balances: one getMultipleAccounts read per poll tick for every wallet's
// SOL, plus per-wallet getTokenAccountsByOwner reads for the curve token
// when a mint is tracked (the trade panel's token-address input, or the
// mint set after a successful launch). All reads go through the rotating
// RPC pool connection (lib/connection.ts).
//
// M4-UI-MATCH restyle: the roster no longer renders its own card; it sits
// inside the trade panel card under the managed-wallet tabs, mirroring
// v4's roster region (shared table below the tabs). Logic is untouched.
//
// M8B key management: the strip gained a Random generator (count input +
// Random button, lib/distribute.ts generateRandomWallets) and every Add
// (Import) AND Random fires an automatic PK backup download (lib/distribute.ts
// exportPksBackup) covering every KEYED wallet, with a PK BACKUP toast.
//
// M8D roster parity (this pass): the FIRST roster wallet is the HUB
// (wallets[0]) — unselectable everywhere (no checkbox, excluded from
// toggleAll/toggleBatchFrom/selectedCount/header checkbox; a muted HUB tag
// sits in its checkbox cell). The sol column header carries the Sigma total
// of every wallet's SOL including the hub. The token column additionally
// values each wallet's raw balance at the live pool price (curve reserves
// while open, the migrated PumpSwap pool reserves once graduated; bigint
// math, display-only approximation) read on the same 5s poll tick and cached
// per mint as priceSolPerTokenRaw. A trailing Act column adds per-row remove
// (x, dust-gated by DUST_SOL_LAMPORTS, hub never removable) and copy-private-
// key. Hygiene banners above the table call out watch-only wallets and a
// stale (last-known-good) balance state when the last poll hit a transport/
// RPC error.

import { Program, type Provider } from '@coral-xyz/anchor'
import { OnlinePumpAmmSdk } from '@pump-fun/pump-swap-sdk'
import { LAMPORTS_PER_SOL, PublicKey } from '@solana/web3.js'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { readAutoCurveState } from '../lib/auto'
import { makeDevnetConnection } from '../lib/connection'
import { exportPksBackup, generateRandomWallets } from '../lib/distribute'
import { shortAddress } from '../lib/format'
import { PUMPFUN_IDL, PUMPFUN_PROGRAM_ID } from '../lib/idl'
import {
    type ManagedWallet,
    freshKeyExpiry,
    loadManagedWallets,
    parseSecretKeys,
    persistManagedWallets,
} from '../lib/managed-wallets'
import {
    CANONICAL_POOL_INDEX,
    WSOL_MINT,
    pumpSwapPoolPda,
} from '../lib/migrate'
import { DECIMALS, DUST_SOL_LAMPORTS } from '../lib/params'
import { useToasts } from './toast-stack'

// Re-exported so existing imports (launch panel, trade panel) keep working.
export { shortAddress }

export interface WalletBalance {
    /** Lamports, null when the read failed (rate limit / transport). */
    sol: bigint | null
    /** Raw token units for the tracked mint, null when unknown. */
    token: bigint | null
}

export interface RosterApi {
    wallets: ManagedWallet[]
    checked: Set<string>
    balances: Map<string, WalletBalance>
    /** The curve mint whose token balances are shown; null = not tracked. */
    trackedMint: string | null
    /** The first roster wallet, the distribution hub. Never selectable and
     *  never removable (disperse source / withdraw default destination).
     *  null while the roster is empty. */
    hubAddress: string | null
    /** Live pool price of the tracked token: lamports per raw token unit
     *  scaled by 10^DECIMALS (so the per-wallet SOL value is
     *  `token * price / 10^DECIMALS`). Null when no mint is tracked, the
     *  curve/pool is missing, or the last price read failed. Display-only
     *  UI approximation, not an exact quote. */
    priceSolPerTokenRaw: bigint | null
    /** True when the last SOL/token/price poll hit a transport/RPC error
     *  (NOT a "curve missing" outcome): the balances shown are the
     *  last-known-good values and a STALE banner is displayed. */
    balancesStale: boolean
    batchSize: string
    importText: string
    importError: string | null
    copiedAddr: string | null
    selectedCount: number
    allChecked: boolean
    setBatchSize: (v: string) => void
    setImportText: (v: string) => void
    handleImport: () => void
    /** Random key generation: count input state (default "1") plus the
     *  generator that mints, merges, auto-checks and backs up. */
    randomCount: string
    setRandomCount: (v: string) => void
    handleRandom: () => void
    toggleAll: () => void
    toggleBatchFrom: (addr: string) => void
    /** Imperative selection setter: the M5 auto engine flashes each round's
     *  picked wallets here (set exact set), and its deselect timer clears it
     *  ~5s later. Only the engine writes whole sets; row clicks stay batch. */
    setCheckedWallets: (next: Set<string>) => void
    copyAddress: (addr: string) => void
    /** Remove one non-hub wallet from the roster. Dust-gated exactly like
     *  v4's per-row x: the wallet's SOL balance must be KNOWN and below
     *  DUST_SOL_LAMPORTS, otherwise an error toast (BALANCE UNKNOWN /
     *  WALLET NOT EMPTY) is pushed and nothing is removed. Token balance
     *  does not gate removal. The hub is never removable. */
    removeWallet: (addr: string) => void
    /** Copy a wallet's base58 64-byte secret to the clipboard (KEY COPIED
     *  toast). Watch-only rows push NO KEY. The secret is never logged. */
    copyPrivateKey: (addr: string) => void
    setTrackedMint: (mint: string | null) => void
    /** Force one balance poll tick immediately (e.g. after a sell-all so the
     *  roster token/SOL columns reflect the landed txs without waiting for
     *  the next 5s interval). */
    refreshBalances: () => void
}

/** Parsed token-account data shape from getParsedTokenAccountsByOwner
 *  (jsonParsed encoding; getTokenAccountsByOwner defaults to base64 and
 *  would return raw bytes, not `.parsed`). */
interface ParsedTokenAccountData {
    parsed?: { info?: { tokenAmount?: { amount?: string } } }
}

const POLL_MS = 5_000

/** SOL display for the per-wallet sol column. */
function fmtSol(lamports: bigint | null): string {
    return lamports === null
        ? '—'
        : `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`
}

/** Raw token display (4 decimals, spec's `123.4567` shape). */
function fmtToken(raw: bigint | null): string {
    return raw === null ? '—' : `${(Number(raw) / 10 ** DECIMALS).toFixed(4)}`
}

/** SOL value display used inside the token valuation and the Sigma header. */
function fmtSolValue(lamports: bigint): string {
    return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(4)}`
}

/**
 * Live pool price of a tracked mint: SOL-per-token as raw fixed-point
 * (lamports * 10^DECIMALS per raw token unit). Refreshed on the same poll
 * tick as the balances and cached per mint by the hook. DISPLAY-ONLY UI
 * approximation, never an exact quote:
 *   - NOT graduated: constant-product curve reserves,
 *     solReserve * 10^DECIMALS / tokenReserve (raw units).
 *   - GRADUATED: the migrated PumpSwap pool's actual base/quote token
 *     account balances (quoteReserve * 10^DECIMALS / baseReserve); the pool
 *     is derived exactly like migrateToPumpSwap seeded it.
 * Returns null when the mint has no curve/pool to price against; throws on
 * transport/RPC errors so the caller can flag the balances stale.
 */
async function readSolPerTokenRaw(
    connection: ReturnType<typeof makeDevnetConnection>,
    program: Program,
    mint: PublicKey
): Promise<bigint | null> {
    const read = await readAutoCurveState(program, mint)
    if (read.kind !== 'ok') return null
    const curve = read.curve
    if (curve.graduated) {
        const [poolKey] = pumpSwapPoolPda(
            CANONICAL_POOL_INDEX,
            new PublicKey(curve.creator),
            mint,
            WSOL_MINT
        )
        const poolInfo = await connection.getAccountInfo(poolKey, 'confirmed')
        // Pool absent = migration never ran on this cluster (PumpSwap is
        // mainnet-only), so there is nothing to price against yet.
        if (!poolInfo) return null
        const pool = await new OnlinePumpAmmSdk(connection).fetchPool(poolKey)
        const [baseAcc, quoteAcc] = await Promise.all([
            connection.getTokenAccountBalance(
                pool.poolBaseTokenAccount,
                'confirmed'
            ),
            connection.getTokenAccountBalance(
                pool.poolQuoteTokenAccount,
                'confirmed'
            ),
        ])
        const baseReserve = BigInt(baseAcc.value.amount)
        const quoteReserve = BigInt(quoteAcc.value.amount)
        if (baseReserve <= BigInt(0) || quoteReserve <= BigInt(0)) return null
        return (quoteReserve * BigInt(10 ** DECIMALS)) / baseReserve
    }
    if (curve.solReserve <= BigInt(0) || curve.tokenReserve <= BigInt(0)) {
        return null
    }
    return (curve.solReserve * BigInt(10 ** DECIMALS)) / curve.tokenReserve
}

export function useRoster(): RosterApi {
    const [wallets, setWallets] = useState<ManagedWallet[]>([])
    const [checked, setChecked] = useState<Set<string>>(new Set())
    const [balances, setBalances] = useState<Map<string, WalletBalance>>(
        new Map()
    )
    const [trackedMint, setTrackedMintState] = useState<string | null>(null)
    const [priceSolPerTokenRaw, setPriceSolPerTokenRaw] = useState<
        bigint | null
    >(null)
    const [balancesStale, setBalancesStale] = useState(false)
    const [batchSize, setBatchSize] = useState('2')
    const [importText, setImportText] = useState('')
    const [importError, setImportError] = useState<string | null>(null)
    const [copiedAddr, setCopiedAddr] = useState<string | null>(null)
    const [randomCount, setRandomCount] = useState('1')

    // PK-backup toasts live on the global toast stack (ToastProvider is
    // mounted above the board page, which owns this hook).
    const { pushToast } = useToasts()

    const connRef = useRef<ReturnType<typeof makeDevnetConnection> | null>(null)
    if (connRef.current === null) connRef.current = makeDevnetConnection()
    const connection = connRef.current

    /** Minimal-provider anchor Program for the curve/pool price reads (anchor
     *  Wallet is Node-only in the browser; every tx here is signed manually
     *  with Keypairs, so a fake publicKey suffices, same as the trade panel). */
    const programRef = useRef<Program | null>(null)

    /** Monotonic tick sequence: a slower in-flight tick that started before a
     *  mint change must never overwrite the newer tick's state. */
    const tickSeqRef = useRef(0)

    /** Latest hub address for imperative callbacks that stay stable. */
    const hubRef = useRef<string | null>(null)

    // The hub is the FIRST roster wallet. Its key role: disperse source /
    // withdraw default destination (Prompt C consumes it via RosterApi).
    const hubAddress = wallets.length > 0 ? (wallets[0]?.address ?? null) : null
    // Keep the hub address in a ref for the stable setCheckedWallets callback
    // (it must not close over a changing hubAddress). Written in an effect so
    // the ref is never mutated during render (react-hooks/refs).
    useEffect(() => {
        hubRef.current = hubAddress
    }, [hubAddress])

    /** Every wallet except the hub: the only rows a checkbox can select. */
    const selectableWallets = useMemo(() => {
        const hub = hubAddress
        return hub ? wallets.filter((w) => w.address !== hub) : wallets
    }, [wallets, hubAddress])

    // Load the persisted roster once on mount.
    useEffect(() => {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage read on mount is the single source of truth
        setWallets(loadManagedWallets())
    }, [])

    // Persist on every change (rolling 1440h TTL is enforced in here).
    useEffect(() => {
        persistManagedWallets(wallets)
    }, [wallets])

    const selectedCount = useMemo(
        () => selectableWallets.filter((w) => checked.has(w.address)).length,
        [selectableWallets, checked]
    )
    const allChecked =
        selectableWallets.length > 0 &&
        selectableWallets.every((w) => checked.has(w.address))

    /** One balance poll tick: SOL via getMultipleAccounts, token via
     *  getTokenAccountsByOwner per wallet when a mint is tracked, plus the
     *  live pool price for the tracked mint. A failed read keeps the previous
     *  value instead of blanking the column and sets the balancesStale flag
     *  (cleared on the next fully successful poll). */
    const tick = useCallback(async () => {
        const conn = connection
        const seq = ++tickSeqRef.current
        const addresses = wallets.map((w) => w.address)
        if (addresses.length === 0) return

        // A poll is "stale" when any transport/RPC read in it failed; the
        // displayed balances are then last-known-good. Cleared below when the
        // whole tick succeeds.
        let pollFailed = false

        const solMap = new Map<string, bigint | null>()
        try {
            const infos = await conn.getMultipleAccountsInfo(
                addresses.map((a) => new PublicKey(a)),
                'confirmed'
            )
            if (seq !== tickSeqRef.current) return
            addresses.forEach((a, i) => {
                solMap.set(a, infos[i] ? BigInt(infos[i]!.lamports) : null)
            })
        } catch {
            // transport/RPC failure: keep previous SOL balances, flag stale
            pollFailed = true
        }

        const tokenMap = new Map<string, bigint>()
        if (trackedMint) {
            const mint = new PublicKey(trackedMint)
            const results = await Promise.all(
                addresses.map(async (a): Promise<[string, bigint] | null> => {
                    try {
                        // getParsedTokenAccountsByOwner (NOT getTokenAccountsByOwner:
                        // the base64 default returns raw bytes, so `data.parsed` is
                        // undefined and every balance reads as 0).
                        const r = await conn.getParsedTokenAccountsByOwner(
                            new PublicKey(a),
                            { mint },
                            'confirmed'
                        )
                        let sum = BigInt(0)
                        for (const acc of r.value) {
                            const data = acc.account
                                .data as unknown as ParsedTokenAccountData
                            const amount =
                                data.parsed?.info?.tokenAmount?.amount
                            if (typeof amount === 'string')
                                sum += BigInt(amount)
                        }
                        return [a, sum]
                    } catch {
                        // transport/RPC failure: keep this wallet's previous token
                        // balance, flag stale
                        pollFailed = true
                        return null
                    }
                })
            )
            if (seq !== tickSeqRef.current) return
            for (const r of results) {
                if (r) tokenMap.set(r[0], r[1])
            }
        }

        // Live pool price for the token valuation (display-only; a failed or
        // missing price read yields null so the raw balance alone is shown).
        let price: bigint | null = null
        if (trackedMint) {
            if (!programRef.current) {
                const provider = {
                    connection,
                    publicKey: PUMPFUN_PROGRAM_ID,
                    wallet: { publicKey: PUMPFUN_PROGRAM_ID },
                } as Provider
                programRef.current = new Program(PUMPFUN_IDL, provider)
            }
            try {
                price = await readSolPerTokenRaw(
                    conn,
                    programRef.current,
                    new PublicKey(trackedMint)
                )
            } catch {
                price = null
                pollFailed = true
            }
        }
        if (seq !== tickSeqRef.current) return

        setPriceSolPerTokenRaw(price)
        setBalancesStale(pollFailed)
        setBalances((prev) => {
            const next = new Map(prev)
            for (const [a, v] of solMap) {
                next.set(a, { sol: v, token: next.get(a)?.token ?? null })
            }
            for (const [a, v] of tokenMap) {
                next.set(a, { sol: next.get(a)?.sol ?? null, token: v })
            }
            return next
        })
    }, [connection, wallets, trackedMint])

    useEffect(() => {
        void tick()
        const id = setInterval(() => void tick(), POLL_MS)
        return () => clearInterval(id)
    }, [tick])

    const handleImport = () => {
        const parsed = parseSecretKeys(importText)
        if (parsed.length === 0) {
            setImportError('ENTER AT LEAST ONE VALID BASE58 SECRET (64 BYTES)')
            return
        }
        const next = [...wallets]
        for (const p of parsed) {
            const idx = next.findIndex((w) => w.address === p.address)
            if (idx >= 0) {
                // Address is the identifier: re-entering a key re-attaches it and
                // rolls its 1440h persistence window (exact base58, case-sensitive).
                next[idx] = {
                    ...next[idx],
                    key: p.key,
                    keyExpiresAt: freshKeyExpiry(),
                }
            } else {
                next.push({
                    address: p.address,
                    key: p.key,
                    keyExpiresAt: freshKeyExpiry(),
                })
            }
        }
        setWallets(next)
        // Auto-check newly imported wallets so the launch flow can select them.
        // The HUB (the first roster wallet after the merge) is never selectable:
        // on an EMPTY roster the first imported wallet becomes the hub, and a
        // re-entered key for the existing hub must not check it either.
        setChecked((prev) => {
            const nextSet = new Set(prev)
            const hub = next[0]?.address
            if (hub) nextSet.delete(hub)
            for (const p of parsed) {
                if (p.address !== hub) nextSet.add(p.address)
            }
            return nextSet
        })
        setImportText('')
        setImportError(null)
        // Safety backup: EVERY keyed wallet (pre-existing ones included) is
        // downloaded to a timestamped pk.json so keys can't be lost.
        const saved = exportPksBackup(next)
        if (saved)
            pushToast({
                action: `PK BACKUP: ${saved} (${next.filter((w) => w.key).length} KEYS)`,
                tone: 'ok',
            })
    }

    /** Generate `randomCount` fresh keypairs, merge them into the roster the
     *  same way handleImport merges (address is the identifier: a collision
     *  re-attaches + rolls the expiry window instead of duplicating the row),
     *  auto-check the new addresses so they can be traded/launched
     *  immediately, then fire the PK backup. Since M8D the FIRST roster
     *  wallet is the HUB (never selectable): on an EMPTY roster the first
     *  generated wallet becomes the hub and is NOT auto-checked. */
    const handleRandom = () => {
        const generated = generateRandomWallets(Number(randomCount))
        const next = [...wallets]
        for (const g of generated) {
            const idx = next.findIndex((w) => w.address === g.address)
            if (idx >= 0) {
                // Astronomically unlikely collision; re-attach + roll the window.
                next[idx] = {
                    ...next[idx],
                    key: g.key,
                    keyExpiresAt: g.keyExpiresAt,
                }
            } else {
                next.push(g)
            }
        }
        setWallets(next)
        setChecked((prev) => {
            const nextSet = new Set(prev)
            const hub = next[0]?.address
            if (hub) nextSet.delete(hub)
            for (const g of generated) {
                if (g.address !== hub) nextSet.add(g.address)
            }
            return nextSet
        })
        // Safety backup: every keyed wallet is downloaded to a timestamped
        // pk.json so the freshly generated keys can't be lost.
        const saved = exportPksBackup(next)
        if (saved)
            pushToast({
                action: `PK BACKUP: ${saved} (${next.filter((w) => w.key).length} KEYS)`,
                tone: 'ok',
            })
    }

    const toggleAll = () => {
        setChecked((prev) => {
            const everyChecked =
                selectableWallets.length > 0 &&
                selectableWallets.every((w) => prev.has(w.address))
            return everyChecked
                ? new Set<string>()
                : new Set(selectableWallets.map((w) => w.address))
        })
    }

    /** Checkbox toggle: a batch of N anchored at the clicked row (v4
     *  semantics). An unselected row ADDS the batch (clicked + next N-1); a
     *  selected row removes it, so successive clicks build up N + N + N. The
     *  hub (wallets[0]) is never part of a batch: slices starting at or after
     *  row 1 can never include it, and the filter keeps it out defensively. */
    const toggleBatchFrom = (addr: string) => {
        const n = Math.max(1, Math.min(Number(batchSize) || 1, wallets.length))
        const start = Math.max(
            0,
            wallets.findIndex((w) => w.address === addr)
        )
        const batch = wallets
            .slice(start, start + n)
            .filter((w) => w.address !== hubAddress)
            .map((w) => w.address)
        setChecked((prev) => {
            const next = new Set(prev)
            if (batch.length === 0) return next
            if (next.has(addr)) {
                for (const a of batch) next.delete(a)
            } else {
                for (const a of batch) next.add(a)
            }
            return next
        })
    }

    const copyAddress = (addr: string) => {
        navigator.clipboard
            .writeText(addr)
            .then(() => setCopiedAddr(addr))
            .catch(() => setCopiedAddr('__fail__'))
        setTimeout(() => setCopiedAddr(null), 1500)
    }

    /** Per-row remove (Act column x). Mirrors v4's removeWallet dust gate:
     *  the wallet's SOL balance must be KNOWN and below DUST_SOL_LAMPORTS;
     *  token balance does NOT gate removal. The hub is never removable. */
    const removeWallet = (addr: string) => {
        if (addr === hubAddress) {
            pushToast({ action: 'HUB CANNOT BE REMOVED', tone: 'error' })
            return
        }
        const sol = balances.get(addr)?.sol ?? null
        if (sol === null) {
            pushToast({
                action: 'BALANCE UNKNOWN',
                amount: shortAddress(addr, 6),
                tone: 'error',
            })
            return
        }
        if (sol >= DUST_SOL_LAMPORTS) {
            pushToast({
                action: 'WALLET NOT EMPTY',
                amount: shortAddress(addr, 6),
                tone: 'error',
            })
            return
        }
        setWallets((prev) => prev.filter((w) => w.address !== addr))
        setChecked((prev) => {
            const next = new Set(prev)
            next.delete(addr)
            return next
        })
    }

    /** Per-row copy of the base58 64-byte secret. Never logs the key; the
     *  clipboard only. Watch-only rows get a NO KEY toast. */
    const copyPrivateKey = (addr: string) => {
        const wallet = wallets.find((w) => w.address === addr)
        if (!wallet?.key) {
            pushToast({
                action: 'NO KEY',
                amount: shortAddress(addr, 6),
                tone: 'error',
            })
            return
        }
        navigator.clipboard
            .writeText(wallet.key)
            .then(() =>
                pushToast({
                    action: 'KEY COPIED',
                    amount: shortAddress(addr, 6),
                    tone: 'ok',
                })
            )
            .catch(() =>
                pushToast({
                    action: 'COPY FAILED',
                    amount: shortAddress(addr, 6),
                    tone: 'error',
                })
            )
    }

    const setCheckedWallets = useCallback((next: Set<string>) => {
        const nextSet = new Set(next)
        const hub = hubRef.current
        if (hub) nextSet.delete(hub)
        setChecked(nextSet)
    }, [])

    const setTrackedMint = useCallback((mint: string | null) => {
        setTrackedMintState(mint)
        // A mint switch must never show the previous mint's valuation: clear
        // the cached price immediately (the next tick re-reads it for the new
        // mint and the tick-seq guard drops any stale in-flight tick).
        setPriceSolPerTokenRaw(null)
    }, [])

    const refreshBalances = useCallback(() => {
        void tick()
    }, [tick])

    return {
        wallets,
        checked,
        balances,
        trackedMint,
        hubAddress,
        priceSolPerTokenRaw,
        balancesStale,
        batchSize,
        importText,
        importError,
        copiedAddr,
        selectedCount,
        allChecked,
        setBatchSize,
        setImportText,
        handleImport,
        randomCount,
        setRandomCount,
        handleRandom,
        toggleAll,
        toggleBatchFrom,
        setCheckedWallets,
        copyAddress,
        removeWallet,
        copyPrivateKey,
        setTrackedMint,
        refreshBalances,
    }
}

export function Roster({ api }: { api: RosterApi }) {
    const hubAddress = api.hubAddress

    // Sigma total in the sol header: every wallet's SOL INCLUDING the hub;
    // null/unknown reads contribute nothing. Shown once at least one balance
    // is known (mirrors the per-wallet "—" unknown glyph before the first poll).
    let solTotal = BigInt(0)
    let anySolKnown = false
    for (const w of api.wallets) {
        const s = api.balances.get(w.address)?.sol
        if (s !== null && s !== undefined) {
            solTotal += s
            anySolKnown = true
        }
    }

    if (api.wallets.length === 0) {
        // Empty roster: no table region yet. Keys are added from the
        // Distribute tab of the trade panel (v4 empty-state wording).
        return (
            <p className="label-mono mt-2 text-[10px] opacity-60">
                NO KEYS YET — ADD PRIVATE KEY(S) IN DISTRIBUTE
            </p>
        )
    }

    return (
        <div>
            {/* STALE balances banner: rendered just above the table (v4
            placement). The without-key skip banner lives in the trade
            panel directly below the managed-wallet tabs. */}
            {api.balancesStale ? (
                <p className="label-mono text-[10px] opacity-60 mt-1">
                    STALE — LAST-KNOWN-GOOD BALANCES (RPC UNREACHABLE)
                </p>
            ) : null}

            {/* column header (ink strip) */}
            <div className="label-mono flex items-center gap-2 border-2 border-ink bg-ink px-3 py-1.5 text-paper">
                <div className="flex w-6 shrink-0 items-center">
                    <input
                        type="checkbox"
                        className="checkbox-brutal checkbox-brutal-invert"
                        checked={api.allChecked}
                        onChange={api.toggleAll}
                        title="toggle all selectable wallets (HUB excluded)"
                        aria-label="toggle all wallets"
                    />
                </div>
                <span className="flex-1">Address</span>
                <span
                    className="flex w-28 shrink-0 flex-col text-right"
                    title="Sum SOL balance of all wallets including HUB">
                    <span>SOL</span>
                    <span className="text-[9px] leading-tight opacity-80">
                        {anySolKnown ? `${fmtSolValue(solTotal)} Σ` : '— Σ'}
                    </span>
                </span>
                <span className="flex w-36 shrink-0 flex-col text-right">
                    <span>Token</span>
                </span>
                <span className="w-16 text-right">Act</span>
            </div>

            {/* rows */}
            <div className="border-2 border-t-0 border-ink">
                {api.wallets.map((w) => {
                    const isHub = w.address === hubAddress
                    const bal = api.balances.get(w.address)
                    const copied = api.copiedAddr === w.address
                    const raw = bal?.token ?? null
                    // Display-only valuation at the live pool price; the raw balance
                    // is always shown even when the price read failed or is missing.
                    let valueLamports: bigint | null = null
                    if (raw !== null && api.priceSolPerTokenRaw !== null) {
                        valueLamports =
                            (raw * api.priceSolPerTokenRaw) /
                            BigInt(10 ** DECIMALS)
                    }
                    return (
                        <div
                            key={w.address}
                            className="roster-row flex items-center gap-2 border-b border-ink/25 px-3 py-1.5 last:border-b-0">
                            <div className="flex w-6 shrink-0 items-center">
                                {isHub ? (
                                    <span
                                        className="label-mono text-[9px] leading-none opacity-60"
                                        title="Distribution hub: disperse source / withdraw default destination">
                                        HUB
                                    </span>
                                ) : (
                                    <input
                                        type="checkbox"
                                        className="checkbox-brutal"
                                        checked={api.checked.has(w.address)}
                                        onChange={() =>
                                            api.toggleBatchFrom(w.address)
                                        }
                                        aria-label={`select ${w.address}`}
                                    />
                                )}
                            </div>
                            <button
                                type="button"
                                onClick={() => api.copyAddress(w.address)}
                                className="label-mono min-w-0 flex-1 truncate text-left underline decoration-dotted opacity-80 hover:opacity-100"
                                title={w.address}>
                                {copied ? 'COPIED' : shortAddress(w.address, 6)}
                            </button>
                            <span className="label-mono w-28 shrink-0 text-right opacity-80">
                                {fmtSol(bal?.sol ?? null)}
                            </span>
                            <span className="label-mono flex w-36 shrink-0 flex-col text-right opacity-80">
                                <span>{fmtToken(raw)}</span>
                                {valueLamports !== null && (
                                    <span className="opacity-60">
                                        ({fmtSolValue(valueLamports)} SOL)
                                    </span>
                                )}
                            </span>
                            <span className="flex w-16 shrink-0 items-center justify-end gap-1">
                                {!isHub && (
                                    <button
                                        type="button"
                                        title="Remove wallet"
                                        aria-label={`remove ${w.address}`}
                                        className="p-0.5 text-[13px] leading-none opacity-60 hover:opacity-100"
                                        onClick={() =>
                                            api.removeWallet(w.address)
                                        }>
                                        ×
                                    </button>
                                )}
                                <button
                                    type="button"
                                    title="Copy private key"
                                    aria-label={`copy private key ${w.address}`}
                                    className="p-0.5 opacity-60 hover:opacity-100"
                                    onClick={() =>
                                        api.copyPrivateKey(w.address)
                                    }>
                                    <svg
                                        width="13"
                                        height="13"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                        strokeLinecap="round"
                                        strokeLinejoin="round"
                                        aria-hidden="true">
                                        <rect
                                            x="9"
                                            y="9"
                                            width="13"
                                            height="13"
                                            rx="2"
                                            ry="2"
                                        />
                                        <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
                                    </svg>
                                </button>
                            </span>
                        </div>
                    )
                })}
            </div>
        </div>
    )
}
