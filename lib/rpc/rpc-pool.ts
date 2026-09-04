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
 * - The public defaults (api.mainnet-beta.solana.com / devnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487,
 *   operated by Triton) act as keyless failover.
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

/** Mainnet pool: env NEXT_PUBLIC_SOLANA_RPC_MAINNET + Triton public default. */
export const MAINNET_RPC_POOL: string[] = buildPool(
    'NEXT_PUBLIC_SOLANA_RPC_MAINNET',
    ['https://api.mainnet-beta.solana.com']
)

/** Devnet pool: env NEXT_PUBLIC_SOLANA_RPC_DEVNET + Triton public default. */
export const DEVNET_RPC_POOL: string[] = buildPool(
    'NEXT_PUBLIC_SOLANA_RPC_DEVNET',
    [
        'https://api.devnet.solana.com',
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

/** Next healthy pool URL (round-robin, skipping cooldown'd endpoints). If
 *  every endpoint is cooling down, recycle the whole pool rather than fail a
 *  request that has no alternative. */
function pickNextUrl(pool: string[]): string {
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
    backoffUntil.clear()
    const url = pool[start]
    rrIndex = (start + 1) % pool.length
    return url
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
