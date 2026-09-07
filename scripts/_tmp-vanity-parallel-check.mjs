// THROWAWAY verification for the parallel vanity grinder — delete after use.
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const here = path.dirname(fileURLToPath(import.meta.url))
const { Keypair } = require('@solana/web3.js')
const bs58mod = require('bs58')
const bs58 = bs58mod.default ?? bs58mod
const { grindVanityMintKeypairParallel } = require(
    path.join(here, '..', '.build/lib/vanity-node.js')
)

const cores = os.availableParallelism?.() ?? os.cpus().length
console.log(`cores: ${cores}`)

let last = null
const onProgress = (p) => { last = p }

// 1) SHORT suffix: correctness + parallel rate sanity.
const t0 = Date.now()
const kp = await grindVanityMintKeypairParallel({ suffix: 'pu', onProgress })
const dt = Date.now() - t0
const pub = kp.publicKey.toBase58()
const rt = Keypair.fromSecretKey(kp.secretKey)
const rtPub = rt.publicKey.toBase58()
if (!pub.endsWith('pu')) throw new Error(`FAIL: pubkey ${pub} does not end in 'pu'`)
if (rtPub !== pub) throw new Error(`FAIL: Keypair.fromSecretKey round-trip mismatch ${rtPub} != ${pub}`)
if (kp.secretKey.length !== 64) throw new Error(`FAIL: secretKey length ${kp.secretKey.length}`)
console.log(`SHORT 'pu' OK in ${dt}ms -> ${pub}`)
console.log(`  round-trip OK; final progress: ${JSON.stringify(last)}`)
console.log(`  short-run rate (incl. ~16 worker boots): ${Math.round((last?.attempts ?? 0) * 1000 / Math.max(1, dt))}/s`)

// 2) FULL 'pump' grind, timed.
console.log('grinding "pump" across all cores (timed)...')
const t1 = Date.now()
const kp2 = await grindVanityMintKeypairParallel({ onProgress })
const dt2 = Date.now() - t1
const pub2 = kp2.publicKey.toBase58()
if (!pub2.endsWith('pump')) throw new Error(`FAIL: pubkey ${pub2} does not end in 'pump'`)
const rate = Math.round((last?.attempts ?? 0) * 1000 / Math.max(1, dt2))
console.log(`PUMP OK in ${(dt2 / 1000).toFixed(1)}s -> ${pub2}`)
console.log(`  attempts: ${last?.attempts?.toLocaleString() ?? 'n/a'}, aggregate rate: ${rate.toLocaleString()}/s`)
