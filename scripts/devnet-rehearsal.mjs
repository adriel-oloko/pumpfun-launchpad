// Milestone M7b: full devnet rehearsal (launch -> auto-bot -> sell-all).
//
// Proves the ENTIRE product path against the DEPLOYED devnet program
// (BTE4vdMyUSbvgyyutBWYJsrhxj8XtCHQPjMk4Sfin3xu, ELF-verified in M7a) using
// the SAME lib code the browser runs:
//
//   1. LAUNCH    buildLaunchSequence (fund + create + packed multi-signer
//                buys) sent as Tier 1 normal transactions. Devnet hosts no
//                block engine, so bundles cannot land here: Tier 1 sends are
//                the devnet launch path (Tier 2 = relay fan-out, mainnet).
//   2. AUTO BUY  lib/auto fireAutoBuy: every wallet buys 95% of spendable.
//   3. AUTO SELL lib/auto fireAutoSell: every wallet sells 100% of holdings.
//   4. RE-BUY    fireAutoBuy again so wallets hold tokens.
//   5. SELL ALL  lib/sell-all sellAllManagedWallets (curve route; the curve
//                is not graduated on devnet).
//
// The graduate -> PumpSwap sell-all leg CANNOT run on devnet: filling the
// curve needs 85 SOL of real deposits (the devnet faucet caps at ~2.5 SOL)
// and PumpSwap is a mainnet-only program. That leg is rehearsed on the local
// validator running the SAME .so (tests/pumpfun-m7b-rehearsal.ts). This
// script proves everything devnet can host.
//
// Usage:
//   node scripts/devnet-rehearsal.mjs [--rpc <url>] [--wallets <n>] [--fund <SOL>]
// Requires: funded devnet creator (~/.config/solana/devnet.json, faucet), a
// fresh dev-wallets.json (scripts/gen-wallets.mjs).

import anchorPkg from '@coral-xyz/anchor'
import bs58 from 'bs58'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

execFileSync(
    process.platform === 'win32' ? 'npx.cmd' : 'npx',
    ['tsc', '-p', 'tsconfig.build.json'],
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] }
)

const lib = require(path.join(repoRoot, '.build/lib/bundle/index.js'))
const auto = require(path.join(repoRoot, '.build/lib/auto.js'))
const sellAll = require(path.join(repoRoot, '.build/lib/sell-all.js'))

const { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey, Transaction } =
    await import('@solana/web3.js')

function arg(name, def) {
    const i = process.argv.indexOf(name)
    return i === -1 ? def : process.argv[i + 1]
}
function has(name) {
    return process.argv.includes(name)
}

const rpcUrl = arg(
    '--rpc',
    'https://devnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487'
)
const walletCount = parseInt(arg('--wallets', '4'), 10)
const fundSol = parseFloat(arg('--fund', '0.06'))
const buySol = parseFloat(arg('--buy', '0.025'))
const EXPLORER = 'https://explorer.solana.com'

let failures = 0
const check = (name, cond, extra = '') => {
    console.log(
        `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`
    )
    if (!cond) failures += 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
    const keypairPath =
        process.env.SOLANA_KEYPAIR ??
        path.join(os.homedir(), '.config', 'solana', 'devnet.json')
    const creator = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, 'utf8')))
    )
    const connection = new Connection(rpcUrl, 'confirmed')
    const provider = new anchorPkg.AnchorProvider(
        connection,
        new anchorPkg.Wallet(creator),
        { commitment: 'confirmed' }
    )
    const idl = JSON.parse(
        fs.readFileSync(path.join(repoRoot, 'target/idl/pumpfun.json'), 'utf8')
    )
    const program = new anchorPkg.Program(idl, provider)

    const walletData = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'dev-wallets.json'), 'utf8')
    )
    const devs = walletData.wallets
        .slice(0, walletCount)
        .map((w) => Keypair.fromSecretKey(bs58.decode(w.secret)))
    const walletList = devs.map((d) => ({
        address: d.publicKey.toBase58(),
        key: bs58.encode(d.secretKey),
    }))

    const creatorBal = await connection.getBalance(creator.publicKey)
    console.log(`== devnet rehearsal ==`)
    console.log(`program ${program.programId.toBase58()}`)
    console.log(
        `creator ${creator.publicKey.toBase58()}  ${(creatorBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    )
    console.log(`rpc     ${rpcUrl}`)
    const needed = BigInt(
        Math.round((fundSol * walletCount + 0.2) * LAMPORTS_PER_SOL)
    )
    if (BigInt(creatorBal) < needed) {
        console.error(
            `creator needs at least ${(Number(needed) / LAMPORTS_PER_SOL).toFixed(2)} SOL; fund it at faucet.solana.com`
        )
        process.exit(1)
    }

    // ---- 1. LAUNCH ------------------------------------------------------
    console.log('\n== 1. launch (buildLaunchSequence, Tier 1 sends) ==')
    const nonce = BigInt(Date.now())
    const fundLamports = BigInt(Math.round(fundSol * LAMPORTS_PER_SOL))
    const seq = await lib.buildLaunchSequence({
        program,
        connection,
        creator,
        nonce,
        name: 'M7b Rehearsal',
        symbol: 'M7BR',
        uri: 'https://example.com/m7b-rehearsal.json',
        buys: devs.map((d) => ({
            wallet: d,
            solInLamports: BigInt(Math.round(buySol * LAMPORTS_PER_SOL)),
        })),
        fundLamportsPerWallet: fundLamports,
        autoMigrate: false,
        lockLp: true,
    })
    console.log(
        `migration flags supported by IDL: ${seq.migrationArgsSupported}`
    )

    const pre = await lib.preflightLaunch(connection, seq)
    console.log(`preflight create: ${pre.create.unitsConsumed} CU, ok`)
    for (const c of pre.buyChunks) {
        console.log(
            `  buy chunk (${c.walletCount}): ${c.result.unitsConsumed} CU, ok`
        )
    }

    const sentSigs = []
    const sent = await lib.sendSequentially(connection, seq, {
        onSignature: (label, sig) => {
            sentSigs.push(sig)
            console.log(`[${label}] ${EXPLORER}/tx/${sig}?cluster=devnet`)
        },
    })
    check(
        'launch txs landed (fund + create + buys)',
        sent.length >= 2 + Math.ceil(walletCount / 4),
        `${sent.length} txs`
    )

    const mint = seq.pda.mint
    const mintInfo = await connection.getAccountInfo(mint, 'confirmed')
    check('mint exists on chain', mintInfo !== null)
    console.log(`token ${EXPLORER}/address/${mint.toBase58()}?cluster=devnet`)
    console.log(
        `curve ${EXPLORER}/address/${seq.pda.curveState.toBase58()}?cluster=devnet`
    )

    const tokenBal = async (d) =>
        lib.walletTokenBalance(connection, d.publicKey, mint)
    const balAfterLaunch = []
    for (const d of devs) {
        const t = await tokenBal(d)
        balAfterLaunch.push(Number(t))
        console.log(`  ${d.publicKey.toBase58().slice(0, 12)}  tokens=${t}`)
    }
    check(
        'every dev wallet holds tokens after launch',
        balAfterLaunch.every((b) => b > 0)
    )

    const gate1 = await auto.readAutoCurveState(program, mint)
    check(
        'curve state readable + NOT graduated',
        gate1.kind === 'ok' && gate1.curve.graduated === false
    )
    if (gate1.kind !== 'ok') process.exit(1)
    const curve1 = gate1.curve

    // ---- 2. AUTO BUY round ----------------------------------------------
    console.log(
        '\n== 2. auto BUY round (lib/auto.fireAutoBuy, 95% of spendable) =='
    )
    const buyRound = await auto.fireAutoBuy({
        connection,
        program,
        mint,
        curve: curve1,
        wallets: walletList,
        minSolLamports: BigInt(0),
    })
    console.log(
        `round result: completed=${buyRound.completed} failed=${buyRound.failed} skipped=${buyRound.skipped}`
    )
    check(
        'auto buy round completed every wallet',
        buyRound.completed === walletCount && buyRound.failed === 0
    )

    const gate2 = await auto.readAutoCurveState(program, mint)
    const buyBalances = []
    for (const d of devs) {
        buyBalances.push(Number(await tokenBal(d)))
    }
    check(
        'holdings grew after the auto buy round',
        buyBalances.every((b) => b > 0)
    )

    // ---- 3. AUTO SELL round ---------------------------------------------
    console.log(
        '\n== 3. auto SELL round (lib/auto.fireAutoSell, 100% of holdings) =='
    )
    const sellRound = await auto.fireAutoSell({
        connection,
        program,
        mint,
        wallets: walletList,
        minSellRaw: BigInt(0),
    })
    console.log(
        `round result: completed=${sellRound.completed} failed=${sellRound.failed} skipped=${sellRound.skipped}`
    )
    check(
        'auto sell round completed every wallet',
        sellRound.completed === walletCount && sellRound.failed === 0
    )

    const soldOut = []
    for (const d of devs) {
        const t = await tokenBal(d)
        soldOut.push(Number(t))
        const sol = await connection.getBalance(d.publicKey)
        console.log(
            `  ${d.publicKey.toBase58().slice(0, 12)}  tokens=${t}  sol=${(sol / LAMPORTS_PER_SOL).toFixed(4)}`
        )
    }
    check(
        'auto sell drained every wallet to 0 tokens',
        soldOut.every((b) => b === 0)
    )

    // ---- 4. RE-BUY so the sell-all has a balance to sell -----------------
    console.log('\n== 4. re-buy (auto engine) so sell-all has holdings ==')
    const gate4 = await auto.readAutoCurveState(program, mint)
    if (gate4.kind !== 'ok') process.exit(1)
    const rebuy = await auto.fireAutoBuy({
        connection,
        program,
        mint,
        curve: gate4.curve,
        wallets: walletList,
        minSolLamports: BigInt(0),
    })
    console.log(
        `round result: completed=${rebuy.completed} failed=${rebuy.failed} skipped=${rebuy.skipped}`
    )
    check('re-buy round completed', rebuy.completed === walletCount)

    // ---- 5. SELL ALL ------------------------------------------------------
    console.log(
        '\n== 5. sell-all (lib/sell-all.sellAllManagedWallets, curve route) =='
    )
    const report = await sellAll.sellAllManagedWallets({
        connection,
        program,
        mint,
        wallets: walletList,
        slippagePct: 5,
    })
    console.log(
        `route=${report.route} graduated=${report.graduated} sold=${report.sold} failed=${report.failed} skipped=${report.skipped} total=${report.total}`
    )
    for (const o of report.outcomes) {
        console.log(
            `  ${o.address.slice(0, 12)}  ${o.status}${o.reason ? ` (${o.reason.slice(0, 90)})` : ''}${o.signature ? `  ${EXPLORER}/tx/${o.signature}?cluster=devnet` : ''}`
        )
    }
    check(
        'sell-all sold every keyed wallet (curve route)',
        report.route === 'curve' &&
            report.sold === walletCount &&
            report.failed === 0
    )

    await sleep(2000)
    const finalToks = []
    for (const d of devs) {
        finalToks.push(Number(await tokenBal(d)))
    }
    check(
        'every wallet at 0 tokens after sell-all',
        finalToks.every((b) => b === 0)
    )
    console.log(
        `holders after sell-all (devnet read): ${report.holderCountAfter}`
    )

    const gateFinal = await auto.readAutoCurveState(program, mint)
    check(
        'curve still open + NOT graduated throughout (no accidental fill)',
        gateFinal.kind === 'ok' && gateFinal.curve.graduated === false
    )

    console.log('\n===== devnet rehearsal done =====')
    console.log(
        `mint=${mint.toBase58()} curve=${seq.pda.curveState.toBase58()}`
    )
    console.log(`launch txs: ${sentSigs.join(' ')}`)
    process.exit(failures > 0 ? 1 : 0)
}

main().catch((e) => {
    console.error('REHEARSAL ERROR:', e && e.message ? e.message : e)
    process.exit(1)
})
