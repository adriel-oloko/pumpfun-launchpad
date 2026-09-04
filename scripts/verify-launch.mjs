// Milestone M4: post-launch on-chain verification script.
//
// Reads a launched token's curve state, holder distribution and the
// Metaplex metadata strings (name / symbol / uri) straight from devnet, so a
// launch from the UI (or any launch) can be confirmed without the explorer.
//
// Usage:
//   node scripts/verify-launch.mjs --mint <mintAddress> [--rpc <url>]
//
// The script compiles lib/bundle via tsconfig.build.json (same as
// launch-bundle.mjs) and reuses derivePdas-free reads: the mint address is
// all it needs, the curve/metadata PDAs are derived from the program seeds.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import anchorPkg from '@coral-xyz/anchor'
import { Connection, Keypair, PublicKey } from '@solana/web3.js'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.build.json'],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] }
)
const lib = require(path.join(repoRoot, '.build/lib/bundle/index.js'))

function arg(name, def) {
    const i = process.argv.indexOf(name)
    return i === -1 ? def : process.argv[i + 1]
}

const mintStr = arg('--mint', null)
const rpcUrl = arg(
    '--rpc',
    'https://devnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487'
)
if (!mintStr) {
    console.error(
        'usage: node scripts/verify-launch.mjs --mint <mintAddress> [--rpc <url>]'
    )
    process.exit(1)
}

const EXPLORER = 'https://explorer.solana.com'

async function main() {
    const mint = new PublicKey(mintStr)
    const connection = new Connection(rpcUrl, 'confirmed')
    const keypairPath =
        process.env.SOLANA_KEYPAIR ??
        path.join(os.homedir(), '.config', 'solana', 'devnet.json')
    const creatorSecret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    const creator = Keypair.fromSecretKey(Uint8Array.from(creatorSecret))
    const provider = new anchorPkg.AnchorProvider(
        connection,
        new anchorPkg.Wallet(creator),
        {
            commitment: 'confirmed',
        }
    )
    const idl = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'target/idl/pumpfun.json'), 'utf8')
    )
    const program = new anchorPkg.Program(idl, provider)

    console.log(`=== verify launch: ${mint.toBase58()} ===`)
    console.log(
        `explorer: ${EXPLORER}/address/${mint.toBase58()}?cluster=devnet`
    )

    // Derive the per-mint PDAs exactly like the program (seeds replicated from
    // lib/bundle/launch.ts; the mint is the anchor, creator/nonce are not
    // needed for these).
    const [curveState] = PublicKey.findProgramAddressSync(
        [Buffer.from('curve'), mint.toBuffer()],
        program.programId
    )
    const [mintAuthority] = PublicKey.findProgramAddressSync(
        [Buffer.from('mint_authority'), mint.toBuffer()],
        program.programId
    )
    const [metadata] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('metadata'),
            new PublicKey(
                'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
            ).toBuffer(),
            mint.toBuffer(),
        ],
        new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s')
    )
    console.log(`curve     : ${curveState.toBase58()}`)
    console.log(`metadata  : ${metadata.toBase58()}`)
    console.log(`mint auth : ${mintAuthority.toBase58()}`)

    try {
        const curveData =
            await program.account.curveStateAccount.fetch(curveState)
        console.log(
            `curve state: solReserve=${curveData.solReserve.toString()} tokenReserve=${curveData.tokenReserve.toString()} supplyOut=${curveData.supplyOut.toString()}`
        )
        console.log(
            `price      : ${(Number(curveData.solReserve.toString()) / Number(curveData.tokenReserve.toString())).toFixed(6)} lamports/token`
        )
    } catch (e) {
        console.log(
            `curve state: read failed (${e instanceof Error ? e.message : e})`
        )
    }

    const meta = await lib.readMetadataStrings(connection, metadata)
    if (meta) {
        console.log(`metadata   : name="${meta.name}" symbol="${meta.symbol}"`)
        console.log(`             uri=${meta.uri}`)
    } else {
        console.log('metadata   : could not decode the metadata account')
    }

    try {
        const holders = await lib.holderCount(connection, mint)
        console.log(`holders (getTokenLargestAccounts): ${holders}`)
        const largest = await connection.getTokenLargestAccounts(
            mint,
            'confirmed'
        )
        for (const h of largest.value.slice(0, 8)) {
            console.log(
                `   ${h.address.toBase58()}  ${(Number(h.amount) / 1e6).toFixed(4)} tokens`
            )
        }
    } catch (e) {
        console.log(
            `holders    : read failed (${e instanceof Error ? e.message : e})`
        )
    }

    const info = await connection.getAccountInfo(mint, 'confirmed')
    if (info) {
        console.log(`mint owner : ${info.owner.toBase58()}`)
        console.log(`mint size  : ${info.data.length} bytes`)
    }
    console.log('=== done ===')
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
