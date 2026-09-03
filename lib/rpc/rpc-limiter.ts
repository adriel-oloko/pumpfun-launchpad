/**
 * Shared RPC throttle (sliding-window rate ceiling + concurrency cap).
 * Ported verbatim from v4-launchpad lib/rpc-limiter.ts.
 *
 * WHY: the app can fire 200+ RPC requests in a single tick (managed-wallet
 * roster load, token/pool discovery, quotes, balance polls). Provider
 * endpoints (Helius, Triton, QuickNode) cap requests per second and answer
 * 429 when a burst exceeds it. A concurrency cap alone is not enough: 8
 * requests in flight at ~300ms latency is ~26 req/s, still over a 25 req/s
 * tier. The sliding-window ceiling guarantees at most `ratePerSecond`
 * requests START in any rolling 1-second window, no matter how many callers
 * fire at once.
 *
 * Every RPC HTTP request funnels through one fetchFn (the @solana/web3.js
 * Connection fetch option in later milestones), so this throttles the TOTAL.
 * Queued calls simply wait their turn; the UI resolves when they land.
 *
 * Ordering matters: the concurrency slot is taken FIRST (bounded wait, never
 * consumes the rate window), then the rate slot is consumed at the exact
 * moment the HTTP request starts — so the rate window counts real HTTP
 * starts, not parked queuers.
 *
 * Tunable at build time via NEXT_PUBLIC_RPC_MAX_CONCURRENCY (default 8) and
 * NEXT_PUBLIC_RPC_MAX_RATE (default 20 requests/second).
 */

type RpcLimiterOpts = {
    /** Max HTTP requests in flight at once (the rest queue). */
    concurrency: number
    /** Hard ceiling on requests started per rolling second. */
    ratePerSecond: number
}

function createRpcLimiter({ concurrency, ratePerSecond }: RpcLimiterOpts) {
    let inFlight = 0
    const slotWaiters: Array<() => void> = []
    // Sliding window: timestamps of HTTP requests started in the last 1s.
    const starts: number[] = []

    const sleep = (ms: number) =>
        new Promise<void>((resolve) => setTimeout(resolve, ms))

    const takeSlot = async () => {
        if (inFlight >= concurrency) {
            await new Promise<void>((resolve) => slotWaiters.push(resolve))
        }
        inFlight += 1
    }

    const giveSlot = () => {
        inFlight -= 1
        slotWaiters.shift()?.()
    }

    // Hard ceiling: at most `ratePerSecond` requests may START in any rolling
    // 1s window. When full, sleep until the oldest start ages out.
    const takeRateSlot = async () => {
        for (;;) {
            const now = Date.now()
            while (starts.length > 0 && starts[0] <= now - 1000) starts.shift()
            if (starts.length < ratePerSecond) {
                starts.push(now)
                return
            }
            await sleep(Math.max(1, starts[0] + 1000 - now))
        }
    }

    return {
        async run<T>(fn: () => Promise<T>): Promise<T> {
            await takeSlot()
            try {
                await takeRateSlot()
                return await fn()
            } finally {
                giveSlot()
            }
        },
    }
}

const envInt = (v: string | undefined, fallback: number): number => {
    const n = v ? Number.parseInt(v, 10) : NaN
    return Number.isFinite(n) && n > 0 ? n : fallback
}

export const RPC_LIMITER = createRpcLimiter({
    concurrency: envInt(process.env.NEXT_PUBLIC_RPC_MAX_CONCURRENCY, 8),
    ratePerSecond: envInt(process.env.NEXT_PUBLIC_RPC_MAX_RATE, 20),
})
