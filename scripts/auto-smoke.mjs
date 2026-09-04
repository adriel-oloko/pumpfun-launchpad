// Milestone M5 auto-engine smoke (devnet).
//
// Drives lib/auto.ts (the EXACT engine the browser AUTO tab calls) headlessly:
//   1. Funds N dev wallets from the creator.
//   2. Creates a fresh token (auto_migrate off so rounds never graduate it).
//   3. fireAutoBuy round: expect every funded wallet to buy 95% of its
//      spendable SOL -> token balances appear.
//   4. fireAutoSell round: expect every wallet to sell 100% of its holdings
//      -> token balances go to zero, SOL comes back.
//   5. MIN SOL gate: a buy round with MIN SOL above every wallet's balance
//      must complete 0 (below min = SKIP).
//   6. Re-buy, then MIN % gate: a sell round whose MIN % (of total supply)
//      exceeds every wallet's holding must complete 0 (below min = SKIP).
//
// Usage:
//   node scripts/auto-smoke.mjs [--rpc <url>] [--fund <SOL per wallet>]
//
// Requires: the creator devnet keypair funded (~/​.config/solana/devnet.json),
// scripts/dev-wallets.json present.

import path from 'path'
import os from 'os'
import fs from 'fs'
import { execFileSync } from 'child_process'
import anchorPkg from '@coral-xyz/anchor'
import bs58 from 'bs58'
import {
    Connection,
    Keypair,
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    Transaction,
} from '@solana/web3.js'
import { fileURLToPath } from 'url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

// Rebuild the CJS .build output (lib/auto.ts is included in tsconfig.build).
execFileSync('npx', ['tsc', '-p', 'tsconfig.build.json'], {
    cwd: repoRoot,
    stdio: ['ignore', 'ignore', 'inherit'],
})
const auto = await import(path.join(repoRoot, '.build/lib/auto.js'))
const lib = await import(path.join(repoRoot, '.build/lib/bundle/index.js'))
const params = await import(path.join(repoRoot, '.build/lib/params.js'))

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
const fundSol = parseFloat(arg('--fund', '0.10'))
const devCount = parseInt(arg('--wallets', '3'), 10)

const EXPLORER = 'https://explorer.solana.com'
let failures = 0
function check(name, cond, extra = '') {
    console.log(
        `${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? `  (${extra})` : ''}`
    )
    if (!cond) failures += 1
}

async function main() {
    const keypairPath =
        process.env.SOLANA_KEYPAIR ??
        path.join(os.homedir(), '.config', 'solana', 'devnet.json')
    const creatorSecret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    const creator = Keypair.fromSecretKey(Uint8Array.from(creatorSecret))

    const connection = new Connection(rpcUrl, 'confirmed')
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

    const walletData = JSON.parse(
        fs.readFileSync(path.join(__dirname, 'dev-wallets.json'), 'utf8')
    )
    const entries = walletData.wallets.slice(0, devCount)
    const devs = entries.map((w) => {
        const kp = Keypair.fromSecretKey(bs58.decode(w.secret))
        return { kp, key: w.secret }
    })

    const creatorBal = await connection.getBalance(creator.publicKey)
    console.log(
        `creator ${creator.publicKey.toBase58()} balance ${(creatorBal / LAMPORTS_PER_SOL).toFixed(4)} SOL`
    )
    if (creatorBal < BigInt(Math.round(0.1 * LAMPORTS_PER_SOL) * 2)) {
        console.error(
            'creator balance too low to fund + create; fund it first (faucet.solana.com)'
        )
        process.exit(1)
    }

    // ---- 1. fund the dev wallets -------------------------------------
    console.log('\n== funding dev wallets ==')
    const fundLamports = Math.round(fundSol * LAMPORTS_PER_SOL)
    const latestBlockhash = await connection.getLatestBlockhash('confirmed')
    const fundTx = new Transaction({ feePayer: creator.publicKey })
    fundTx.recentBlockhash = latestBlockhash.blockhash
    fundTx.lastValidBlockHeight = latestBlockhash.lastValidBlockHeight
    for (const d of devs) {
        fundTx.add(
            SystemProgram.transfer({
                fromPubkey: creator.publicKey,
                toPubkey: d.kp.publicKey,
                lamports: fundLamports,
            })
        )
    }
    fundTx.sign(creator)
    const fundSig = await connection.sendRawTransaction(fundTx.serialize())
    await connection.confirmTransaction(fundSig, 'confirmed')
    console.log(
        `funded ${devs.length} wallets x ${fundSol} SOL: ${EXPLORER}/tx/${fundSig}?cluster=devnet`
    )

    for (const d of devs) {
        const b = await connection.getBalance(d.kp.publicKey)
        check(
            `wallet ${d.kp.publicKey.toBase58().slice(0, 12)} funded`,
            b >= BigInt(fundLamports),
            `${(b / LAMPORTS_PER_SOL).toFixed(4)} SOL`
        )
    }

    // ---- 2. create a token -------------------------------------------
    console.log('\n== create token ==')
    const nonce = BigInt(Date.now())
    const pda = lib.derivePdas(program.programId, creator.publicKey, nonce)
    const createIx = await lib.buildCreateIx(
        program,
        creator.publicKey,
        pda,
        nonce,
        'M5 Auto Smoke',
        'M5AS',
        'https://example.com/m5-auto-smoke.json',
        { autoMigrate: false, lockLp: false }
    )
    const createLatest = await connection.getLatestBlockhash('confirmed')
    const createTx = new Transaction({ feePayer: creator.publicKey })
    createTx.recentBlockhash = createLatest.blockhash
    createTx.lastValidBlockHeight = createLatest.lastValidBlockHeight
    createTx.add(createIx)
    createTx.sign(creator)
    const createSig = await connection.sendRawTransaction(createTx.serialize())
    await connection.confirmTransaction(createSig, 'confirmed')
    const mintStr = pda.mint.toBase58()
    console.log(
        `created mint ${mintStr} (${EXPLORER}/address/${mintStr}?cluster=devnet)`
    )
    console.log(
        `curve ${pda.curveState.toBase58()} (${EXPLORER}/address/${pda.curveState.toBase58()}?cluster=devnet)`
    )

    const gate = await auto.readAutoCurveState(program, pda.mint)
    check(
        'curve state readable',
        gate.kind === 'ok',
        gate.kind === 'ok'
            ? `creator ${gate.curve.creator.slice(0, 12)} graduated=${gate.curve.graduated}`
            : 'missing'
    )
    if (gate.kind !== 'ok') process.exit(1)
    const curve = gate.curve
    check('curve NOT graduated at start', curve.graduated === false)

    const mintBal = async (d) =>
        lib.walletTokenBalance(connection, d.kp.publicKey, pda.mint)
    const solBal = async (d) => connection.getBalance(d.kp.publicKey)
    const walletList = devs.map((d) => ({
        address: d.kp.publicKey.toBase58(),
        key: d.key,
    }))
    const minSolLamports = BigInt(0)

    // ---- 3. auto BUY round -------------------------------------------
    console.log('\n== auto buy round (3 wallets, 95% of spendable) ==')
    const buyRes = await auto.fireAutoBuy({
        connection,
        program,
        mint: pda.mint,
        curve,
        wallets: walletList,
        minSolLamports,
    })
    console.log('round result:', JSON.stringify(buyRes))
    check(
        'buy round completed 3',
        buyRes.completed === 3,
        `completed=${buyRes.completed} failed=${buyRes.failed} skipped=${buyRes.skipped}`
    )

    const tokenAfterBuy = []
    for (const d of devs) {
        const t = await mintBal(d)
        const s = await solBal(d)
        tokenAfterBuy.push(Number(t))
        console.log(
            `  ${d.kp.publicKey.toBase58().slice(0, 12)}  tokens=${t}  sol=${(s / LAMPORTS_PER_SOL).toFixed(4)}`
        )
        check(
            `wallet ${d.kp.publicKey.toBase58().slice(0, 12)} holds tokens after buy`,
            t > BigInt(0)
        )
    }

    // ---- 4. auto SELL round ------------------------------------------
    console.log(
        '\n== auto sell round (3 wallets, 100% of holdings, MIN % off) =='
    )
    const sellRes = await auto.fireAutoSell({
        connection,
        program,
        mint: pda.mint,
        wallets: walletList,
        minSellRaw: BigInt(0),
    })
    console.log('round result:', JSON.stringify(sellRes))
    check(
        'sell round completed 3',
        sellRes.completed === 3,
        `completed=${sellRes.completed} failed=${sellRes.failed} skipped=${sellRes.skipped}`
    )

    for (const d of devs) {
        const t = await mintBal(d)
        const s = await solBal(d)
        console.log(
            `  ${d.kp.publicKey.toBase58().slice(0, 12)}  tokens=${t}  sol=${(s / LAMPORTS_PER_SOL).toFixed(4)}`
        )
        check(
            `wallet ${d.kp.publicKey.toBase58().slice(0, 12)} sold out (0 tokens)`,
            t === BigInt(0)
        )
    }

    // ---- 5. MIN SOL gate ---------------------------------------------
    console.log(
        '\n== MIN SOL gate: round with MIN SOL = 1 SOL (every wallet below) =='
    )
    const gateBuy = await auto.fireAutoBuy({
        connection,
        program,
        mint: pda.mint,
        curve,
        wallets: walletList,
        minSolLamports: BigInt(LAMPORTS_PER_SOL),
    })
    console.log('round result:', JSON.stringify(gateBuy))
    check(
        'MIN SOL gate skipped all (0 completed)',
        gateBuy.completed === 0 && gateBuy.skipped === 3,
        `completed=${gateBuy.completed} skipped=${gateBuy.skipped}`
    )

    // ---- 6. re-buy for the MIN % gate test ----------------------------
    console.log('\n== re-buy (MIN SOL off) so wallets hold tokens again ==')
    const rebuy = await auto.fireAutoBuy({
        connection,
        program,
        mint: pda.mint,
        curve,
        wallets: walletList,
        minSolLamports,
    })
    console.log('round result:', JSON.stringify(rebuy))
    check('re-buy completed 3', rebuy.completed === 3)
    const holdRaw = await mintBal(devs[0])
    console.log(
        `top wallet holding after re-buy: ${holdRaw} raw (total supply ${params.TOTAL_SUPPLY.toString()})`
    )

    // ---- 7. MIN % gate ------------------------------------------------
    console.log(
        '\n== MIN % gate: sell round with MIN % = 80 (below-threshold wallets skipped) =='
    )
    const minRaw80 = auto.autoSellMinRaw(80) // 80% of total supply
    const gateSell = await auto.fireAutoSell({
        connection,
        program,
        mint: pda.mint,
        wallets: walletList,
        minSellRaw: minRaw80,
    })
    console.log('round result:', JSON.stringify(gateSell))
    check(
        'MIN % gate skipped all (holdings below 80% of supply)',
        gateSell.completed === 0,
        `completed=${gateSell.completed} skipped=${gateSell.skipped} minRaw=${minRaw80}`
    )

    console.log('\n===== auto-engine smoke done =====')
    console.log(`mint=${mintStr} curve=${pda.curveState.toBase58()}`)
    console.log(
        `wallets hold tokens (for the browser AUTO demo): ${(await mintBal(devs[0])) > BigInt(0) ? 'yes' : 'no'}`
    )
    process.exit(failures > 0 ? 1 : 0)
}

main().catch((e) => {
    console.error('SMOKE ERROR:', e && e.message ? e.message : e)
    process.exit(1)
})
