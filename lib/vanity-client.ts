'use client'

// Browser-only Web Worker pool for the vanity "pump" mint grind.
//
// BUILD-CONTEXT CONTRACT: `new Worker(new URL(...))` + import.meta.url are
// browser/client-module-only constructs, so this file (and lib/vanity.worker.ts)
// must NEVER be imported by lib/bundle/** — tsconfig.build.json compiles that
// tree to CommonJS where import.meta.url is a compile error. Only 'use client'
// components (components/launch-panel.tsx) import this module.
//
// The lib/bundle default mint path (lib/vanity.ts, CJS-safe) stays
// single-threaded for the Node CLI scripts; the browser UI takes this parallel
// path instead: up to `maxWorkers` (default 16, bounded by hardwareConcurrency)
// Web Workers each grind ~17k keypairs/s with libsodium, cutting the ~11 min
// single-threaded expectation for "pump" (58^4 ≈ 11.3M attempts) to ~35-75s.
//
// SECURITY: workers post the winning 64-byte secret key to this module, which
// wraps it in a @solana/web3.js Keypair for the create tx signer set. The
// secret never leaves the page, is never logged, and dies after the create tx.
import { Keypair } from '@solana/web3.js'
import {
    DEFAULT_VANITY_SUFFIX,
    grindVanityMintKeypair as grindVanityMintKeypairSingleThread,
    vanityAbortError,
} from './vanity'
import type { VanityGrindOptions, VanityGrindProgress } from './vanity'

/** Hard cap on concurrent grind workers (browser). 16 workers at ~17k
 *  keypairs/s each ≈ 35-75s for the default "pump" suffix (also bounded by
 *  navigator.hardwareConcurrency, so a 4-core laptop still caps at 4). */
export const DEFAULT_MAX_WORKERS = 16

export interface VanityClientGrindOptions extends VanityGrindOptions {
    /** Cap on concurrent workers (default DEFAULT_MAX_WORKERS; also bounded
     *  by navigator.hardwareConcurrency). */
    maxWorkers?: number
}

interface FoundMessage {
    type: 'found'
    pubkey: string
    secretKey: ArrayBuffer
}

interface ProgressMessage {
    type: 'progress'
    attempts: number
}

interface ErrorMessage {
    type: 'error'
    message: string
}

type WorkerMessage = FoundMessage | ProgressMessage | ErrorMessage

/** Grinds a fresh ed25519 Keypair whose base58 pubkey ends in `suffix`
 *  (default "pump") using a pool of Web Workers; falls back to the
 *  single-threaded CJS-safe core (lib/vanity.ts) when Workers are unavailable
 *  (SSR, older browsers). Resolves with the Keypair or rejects with an
 *  AbortError when `signal` aborts. */
export async function grindVanityMintKeypair(
    opts: VanityClientGrindOptions = {}
): Promise<Keypair> {
    const { onProgress, signal } = opts
    const suffix = opts.suffix ?? DEFAULT_VANITY_SUFFIX

    // No Worker (SSR/prerender environment, non-browser runtime): the core is
    // CJS-safe and yields to the event loop, so it is a correct fallback.
    if (typeof window === 'undefined' || typeof Worker === 'undefined') {
        return grindVanityMintKeypairSingleThread({ suffix, onProgress, signal })
    }

    const workerCount = Math.max(
        1,
        Math.min(
            opts.maxWorkers ?? DEFAULT_MAX_WORKERS,
            navigator.hardwareConcurrency ?? 4
        )
    )

    return new Promise<Keypair>((resolve, reject) => {
        const workers: Worker[] = []
        let settled = false
        let live = 0
        let totalAttempts = 0
        let lastError: Error | null = null
        const startedAt = Date.now()
        let lastProgressAt = 0

        const cleanup = (): void => {
            for (const worker of workers) worker.terminate()
        }
        const onAbort = (): void => {
            if (settled) return
            settled = true
            cleanup()
            signal?.removeEventListener('abort', onAbort)
            reject(vanityAbortError())
        }
        if (signal) {
            if (signal.aborted) {
                reject(vanityAbortError())
                return
            }
            signal.addEventListener('abort', onAbort, { once: true })
        }

        const reportProgress = (): void => {
            if (!onProgress) return
            const now = Date.now()
            if (now - lastProgressAt < 250) return
            lastProgressAt = now
            const progress: VanityGrindProgress = {
                attempts: totalAttempts,
                attemptsPerSecond: Math.round(
                    (totalAttempts * 1000) / Math.max(1, now - startedAt)
                ),
            }
            onProgress(progress)
        }

        const spawn = (): void => {
            const worker = new Worker(
                new URL('./vanity.worker.ts', import.meta.url),
                { type: 'module' }
            )
            workers.push(worker)
            live += 1
            worker.onmessage = (event: MessageEvent<WorkerMessage>): void => {
                const message = event.data
                if (message.type === 'progress') {
                    totalAttempts += message.attempts
                    reportProgress()
                    return
                }
                if (message.type === 'found') {
                    if (settled) return
                    settled = true
                    cleanup()
                    signal?.removeEventListener('abort', onAbort)
                    resolve(Keypair.fromSecretKey(new Uint8Array(message.secretKey)))
                    return
                }
                // 'error': this worker died; if every worker dies, fall back
                // to the single-threaded core rather than failing the launch.
                live -= 1
                lastError = new Error(message.message)
                if (live === 0 && !settled) {
                    settled = true
                    cleanup()
                    signal?.removeEventListener('abort', onAbort)
                    void grindVanityMintKeypairSingleThread({
                        suffix,
                        onProgress,
                        signal,
                    }).then(resolve, (error: unknown) => {
                        reject(
                            error instanceof Error
                                ? error
                                : lastError ?? new Error(String(error))
                        )
                    })
                }
            }
            worker.onerror = (event: ErrorEvent): void => {
                live -= 1
                lastError = new Error(event.message || 'vanity worker crashed')
                if (live === 0 && !settled) {
                    settled = true
                    cleanup()
                    signal?.removeEventListener('abort', onAbort)
                    void grindVanityMintKeypairSingleThread({
                        suffix,
                        onProgress,
                        signal,
                    }).then(resolve, reject)
                }
            }
            worker.postMessage({ type: 'start', suffix })
        }

        try {
            for (let i = 0; i < workerCount; i += 1) spawn()
        } catch {
            // Worker construction failed (e.g. blocked by CSP): run the grind
            // on the main thread via the yielding CJS-safe core.
            if (!settled) {
                settled = true
                cleanup()
                signal?.removeEventListener('abort', onAbort)
                void grindVanityMintKeypairSingleThread({
                    suffix,
                    onProgress,
                    signal,
                }).then(resolve, reject)
            }
        }
    })
}
