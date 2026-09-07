// THROWAWAY scaling probe: pure grind-loop throughput, main thread vs N workers.
import os from 'node:os'
import { Worker } from 'node:worker_threads'
import sodium from 'libsodium-wrappers'
import { pubkeyTailMatches } from '../.build/lib/vanity-match.js'

const ITER = 300_000
const SUFFIX = 'pump'

function incrementSeed(seed) {
    for (let i = seed.length - 1; i >= 0; i -= 1) {
        seed[i] = (seed[i] + 1) & 0xff
        if (seed[i] !== 0) return
    }
}

// Main thread
await sodium.ready
{
    const seed = sodium.randombytes_buf(32)
    const t = Date.now()
    let n = 0
    while (n < ITER) { incrementSeed(seed); const c = sodium.crypto_sign_seed_keypair(seed); pubkeyTailMatches(c.publicKey, SUFFIX); n += 1 }
    const dt = Date.now() - t
    console.log(`main thread: ${Math.round(ITER / (dt / 1000)).toLocaleString()}/s`)
}

// Workers
const W = Number(process.argv[2] ?? 16)
const code = `
const { parentPort } = require('node:worker_threads')
const sodium = require('libsodium-wrappers')
const { pubkeyTailMatches } = require('./.build/lib/vanity-match.js')
const ITER = ${ITER}
function incrementSeed(seed) { for (let i = seed.length - 1; i >= 0; i -= 1) { seed[i] = (seed[i] + 1) & 0xff; if (seed[i] !== 0) return } }
sodium.ready.then(() => {
  const seed = sodium.randombytes_buf(32)
  const t = Date.now()
  let n = 0
  while (n < ITER) { incrementSeed(seed); const c = sodium.crypto_sign_seed_keypair(seed); pubkeyTailMatches(c.publicKey, '${SUFFIX}'); n += 1 }
  parentPort.postMessage({ n, dt: Date.now() - t })
})
`
const workers = []
const t0 = Date.now()
for (let i = 0; i < W; i += 1) {
    workers.push(new Promise((res, rej) => {
        const w = new Worker(code, { eval: true })
        w.on('message', (m) => res(m))
        w.on('error', rej)
    }))
}
const results = await Promise.all(workers)
const totalN = results.reduce((a, r) => a + r.n, 0)
const maxDt = Math.max(...results.map((r) => r.dt))
const wall = Date.now() - t0
console.log(`${W} workers x ${ITER.toLocaleString()}: aggregate ${Math.round(totalN / (maxDt / 1000)).toLocaleString()}/s (by max worker dt), ${Math.round(totalN / (wall / 1000)).toLocaleString()}/s (incl boot)`)
const per = results.map((r) => Math.round(r.n / (r.dt / 1000)))
console.log(`per-worker /s: ${per.join(', ')}`)
console.log(`physical cores hint:`, os.cpus().map((c) => c.model).filter((v, i, a) => a.indexOf(v) === i))
