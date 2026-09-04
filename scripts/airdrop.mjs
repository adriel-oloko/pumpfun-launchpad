/**
 * Devnet airdrop + balance read (M0 exit criterion).
 *
 * Usage:
 *   node scripts/airdrop.mjs [keypairPath] [lamports]
 *
 * Defaults:
 *   keypairPath = ~/.config/solana/devnet.json (the M0 devnet keypair)
 *   lamports    = 2 * LAMPORTS_PER_SOL (2 SOL)
 *
 * RPC override (keyed Helius/Triton devnet endpoints draw on their own
 * faucet quota and bypass the public devnet rate limit):
 *   SOLANA_DEVNET_RPC=https://devnet.helius-rpc.com/?api-key=... node scripts/airdrop.mjs
 *
 * Depends on @solana/web3.js v1 (package.json).
 */
import { Connection, Keypair, LAMPORTS_PER_SOL } from '@solana/web3.js'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const DEVNET_RPC =
    process.env.SOLANA_DEVNET_RPC ||
    'https://devnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487'

const keypairPath =
    process.argv[2] || join(homedir(), '.config', 'solana', 'devnet.json')

const lamports = process.argv[3]
    ? Number(process.argv[3])
    : 2 * LAMPORTS_PER_SOL

const secret = JSON.parse(readFileSync(keypairPath, 'utf8'))
const keypair = Keypair.fromSecretKey(Uint8Array.from(secret))

const connection = new Connection(DEVNET_RPC, 'confirmed')
const address = keypair.publicKey.toBase58()

console.log(`devnet rpc     : ${DEVNET_RPC}`)
console.log(`keypair        : ${keypairPath}`)
console.log(`address        : ${address}`)

const before = await connection.getBalance(keypair.publicKey)
console.log(`balance before : ${before / LAMPORTS_PER_SOL} SOL`)

try {
    const signature = await connection.requestAirdrop(
        keypair.publicKey,
        lamports
    )
    console.log(`airdrop tx     : ${signature}`)
    await connection.confirmTransaction(signature)
    console.log(`airdrop status : confirmed`)
} catch (err) {
    // The public devnet faucet rate-limits per IP ("reached your airdrop limit
    // today or the faucet has run dry"). Report it and still read the balance.
    console.log(`airdrop status : FAILED (${err.message})`)
}

const after = await connection.getBalance(keypair.publicKey)
console.log(`balance after  : ${after / LAMPORTS_PER_SOL} SOL`)
