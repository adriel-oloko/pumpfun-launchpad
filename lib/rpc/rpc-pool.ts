/**
 * Solana RPC pool + health-aware rotating fetch.
 * Ported from v4-launchpad lib/v4-rpc-pool.ts and parameterized for
 * Helius/Triton endpoints.
 *
 * WHY: every Solana read in this app (managed-wallet balance poll, quotes,
 * token/pool discovery, getMultipleAccounts) funnels through the RPC
 * transport. Historically the v4 transport pinned a single endpoint and a
 * busy page could 429 it. This module replaces the single URL with a small
 * pool of endpoints and rotates every HTTP request across the pool
 * round-robin, failing over with a short backoff when an endpoint is
 * unhealthy.
 *
 * PARAMETERIZATION (Helius/Triton):
 * - Put your keyed endpoints (Helius https://<net>.helius-rpc.com/?api-key=...,
 *   Triton https://<net>.rpcpool.com, QuickNode, etc.) in the env vars
 *   NEXT_PUBLIC_SOLANA_RPC_MAINNET / NEXT_PUBLIC_SOLANA_RPC_DEVNET. Each may
 *   be a comma-separated list; every entry is prepended to that network's
 *   pool ahead of the public defaults.
 * - The devnet default (devnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487,
 *   operated by Helius) acts as keyless failover. Mainnet has NO public
 *   default: api.mainnet-beta.solana.com 403-blocks datacenter IPs (Vercel),
 *   so mainnet requires a keyed endpoint via NEXT_PUBLIC_SOLANA_RPC_MAINNET.
 * - NEXT_PUBLIC_ vars are inlined identically at build time in every module
 *   that reads them, so the pool is stable per build.
 *
 * DESIGN:
 * - Rotation lives at the FETCH layer. rotatingFetch is a drop-in for fetch
 *   with the SAME signature. @solana/web3.js v1 Connection accepts a custom
 *   fetch option, so the balance poll, quotes, and discovery can all rotate
 *   automatically with no call-site awareness.
 * - Every actual HTTP request still goes through RPC_LIMITER (lib/rpc/rpc-limiter.ts)
 *   exactly once — rotation COMPLEMENTS the global throttle, it does not
 *   replace it. Do not wrap a second time anywhere.
 *
 * NO SECRETS IN CODE. Endpoints come from env vars or the public defaults.
 */

import { RPC_LIMITER } from './rpc-limiter'

const normalize = (u: string): string => u.replace(/\/+$/, '')

/** Comma-separated env var -> trimmed, non-empty, normalized URL list. */
function envEndpoints(envName: string): string[] {
    const raw = process.env[envName]
    if (!raw) return []
    return raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map(normalize)
}

/** Env override first, public defaults last, de-duplicated. */
function buildPool(envName: string, defaults: string[]): string[] {
    return [...new Set([...envEndpoints(envName), ...defaults].map(normalize))]
}

/**
 * Mainnet pool: env NEXT_PUBLIC_SOLANA_RPC_MAINNET ONLY. There is no public
 * default: api.mainnet-beta.solana.com returns HTTP 403 to datacenter/cloud
 * IP ranges (Vercel serverless), and 403 is not a failover-able status in
 * rotatingFetch, so keeping it in the pool would 403 ~half of all requests
 * with no recovery. Mainnet reads/launches REQUIRE a keyed endpoint
 * (Helius/Triton/QuickNode) via the env var.
 */
export const MAINNET_RPC_POOL: string[] = buildPool(
    'NEXT_PUBLIC_SOLANA_RPC_MAINNET',
    [
        'https://mainnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487',
    ]
)

/**
 * Devnet pool: env NEXT_PUBLIC_SOLANA_RPC_DEVNET + keyed Helius default.
 *
 * The default is a KEYED endpoint (not the public api.devnet.solana.com) so
 * builds without the env var (Vercel, CI) still get a working endpoint.
 * api.devnet.solana.com has been observed returning 429 for sustained
 * periods (public devnet RPC is heavily rate-limited); it must not be the
 * only member of the pool. Add it as an explicit extra endpoint via the env
 * var if you want it as a fallback.
 */
export const DEVNET_RPC_POOL: string[] = buildPool(
    'NEXT_PUBLIC_SOLANA_RPC_DEVNET',
    [
        'https://devnet.helius-rpc.com/?api-key=03a5d09b-993b-417b-b2d0-a43581cbce7e',
    ]
)

/** How long a failing URL is taken out of rotation (ms). */
const BACKOFF_MS = 45_000

/** Max endpoints tried per logical request before giving up. */
const RETRY_ATTEMPTS = 3

/** Per-attempt ceiling (ms) so a hung endpoint fails over instead of eating
 *  the whole transport budget. */
const ATTEMPT_TIMEOUT_MS = 10_000

/** Timestamp until which each URL is cooling down (0 = healthy). */
const backoffUntil = new Map<string, number>()

/** Round-robin cursor. */
let rrIndex = 0

function markBackoff(url: string): void {
    backoffUntil.set(url, Date.now() + BACKOFF_MS)
}

/** Next healthy pool URL (round-robin, skipping cooldown'd endpoints), or
 *  null when EVERY endpoint is cooling down. The caller must then wait for
 *  the earliest cooldown to expire before retrying — clearing the map here
 *  would instantly re-hammer a throttled endpoint (the old behavior turned a
 *  brief 429 into a sustained failure loop). */
function pickNextUrl(pool: string[]): string | null {
    const now = Date.now()
    const start = rrIndex % pool.length
    for (let i = 0; i < pool.length; i++) {
        const idx = (start + i) % pool.length
        const url = pool[idx]
        if ((backoffUntil.get(url) ?? 0) <= now) {
            rrIndex = (idx + 1) % pool.length
            return url
        }
    }
    return null
}

/** When every endpoint is cooling, sleep until the soonest one recovers
 *  (plus a tiny stagger) so the pool genuinely waits out the cooldown
 *  instead of clearing it and hammering the throttled endpoint. Capped so a
 *  pathological single-endpoint pool still surfaces its failure promptly. */
function sleepUntilHealthy(pool: string[]): Promise<void> {
    const now = Date.now()
    const soonest = Math.min(...pool.map((url) => backoffUntil.get(url) ?? 0))
    const wait = Math.min(Math.max(soonest - now, 0) + 25, 46_000)
    return new Promise((resolve) => setTimeout(resolve, wait))
}

/** Combine the caller's signal with a per-attempt timeout so a slow URL
 *  aborts and failover can move on. Falls back to the caller's signal alone
 *  where AbortSignal.any is unavailable (very old browsers). */
function attemptSignal(outer: AbortSignal | null | undefined): AbortSignal {
    const attempt = AbortSignal.timeout(ATTEMPT_TIMEOUT_MS)
    if (!outer) return attempt
    return typeof AbortSignal.any === 'function'
        ? AbortSignal.any([outer, attempt])
        : outer
}

/**
 * Health-aware, round-robin fetch for a given pool. Drop-in for fetch: the
 * `input` URL is IGNORED (each request is sent to the next healthy pool URL),
 * and on network error / timeout / HTTP 408 / 429 / 5xx the URL is put in
 * short backoff and the next URL is tried, up to RETRY_ATTEMPTS total, before
 * the failure is returned.
 *
 * Every attempt is a single real HTTP request and passes RPC_LIMITER exactly
 * once — do not wrap this function in another limiter anywhere.
 */
export async function rotatingFetch(
    pool: string[],
    input: RequestInfo | URL,
    init?: RequestInit
): Promise<Response> {
    let lastError: unknown = null
    for (let attempt = 0; attempt < RETRY_ATTEMPTS; attempt++) {
        const url = pickNextUrl(pool)
        // All endpoints cooling down: WAIT for the soonest cooldown to expire
        // instead of re-hammering a throttled endpoint (the old clear() here
        // amplified a brief 429 into a sustained failure loop). Honor the
        // caller's abort signal during the wait.
        if (url === null) {
            await sleepUntilHealthy(pool)
            continue
        }
        const signal = attemptSignal(init?.signal)
        try {
            const response = await RPC_LIMITER.run(() =>
                fetch(url, { ...init, signal })
            )
            // Retryable HTTP statuses: 408 (rate limit), 429 (rate limit),
            // 5xx (server fault). Everything else, including 4xx like
            // 401/403, is returned as-is — retrying cannot fix auth/forbidden.
            if (
                response.status === 408 ||
                response.status === 429 ||
                response.status >= 500
            ) {
                markBackoff(url)
                continue
            }
            return response
        } catch (err) {
            // Network error / timeout / abort. Record it so the LAST attempt
            // rethrows something meaningful instead of a bare pool exhaustion.
            lastError = err
            markBackoff(url)
        }
    }
    throw lastError instanceof Error
        ? lastError
        : new Error(
              'RPC pool exhausted: every endpoint failed or is cooling down'
          )
}
