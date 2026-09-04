// M1 devnet smoke test: create a token, buy on the curve, sell on the curve,
// and print balances + price at each step. Proves the program works on-chain,
// not just in local tests.
//
// Usage: node scripts/smoke-m1.mjs [sol-in] [nonce]
//   - sol-in: how many SOL to buy (default 0.5)
//   - nonce:  u64 nonce for the mint PDA (default: Unix ms)
//
// Uses the devnet keypair from ~/.config/solana/devnet.json as creator, fee
// payer and trader (tiny devnet balances; no whale amounts).

import anchorPkg from '@coral-xyz/anchor'
import {
    LAMPORTS_PER_SOL,
    PublicKey,
    SystemProgram,
    SYSVAR_RENT_PUBKEY,
    SYSVAR_INSTRUCTIONS_PUBKEY,
} from '@solana/web3.js'
import {
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    getAssociatedTokenAddress,
    getMint,
    getAccount,
} from '@solana/spl-token'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const { BN, Program, AnchorProvider, Wallet, web3 } = anchorPkg

const METAPLEX_PROGRAM_ID = new PublicKey(
    'metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s'
)

const MINT_SEED = Buffer.from('mint')
const CURVE_SEED = Buffer.from('curve')
const MINT_AUTHORITY_SEED = Buffer.from('mint_authority')

const solIn = parseFloat(process.argv[2] ?? '0.5')
const nonce = new BN(process.argv[3] ?? Date.now())

async function main() {
    const keypairPath =
        process.env.SOLANA_KEYPAIR ??
        path.join(os.homedir(), '.config/solana/devnet.json')
    const secret = JSON.parse(fs.readFileSync(keypairPath, 'utf8'))
    const keypair = web3.Keypair.fromSecretKey(Uint8Array.from(secret))
    const wallet = new Wallet(keypair)

    const connection = new web3.Connection(
        'https://devnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487',
        'confirmed'
    )
    const provider = new AnchorProvider(connection, wallet, {
        commitment: 'confirmed',
    })

    const idl = JSON.parse(
        fs.readFileSync(
            new URL('../target/idl/pumpfun.json', import.meta.url),
            'utf8'
        )
    )
    const program = new Program(idl, provider) // programId comes from idl.address

    const creator = provider.wallet.publicKey
    const [mint] = PublicKey.findProgramAddressSync(
        [MINT_SEED, creator.toBuffer(), nonce.toArrayLike(Buffer, 'le', 8)],
        program.programId
    )
    const [curveState] = PublicKey.findProgramAddressSync(
        [CURVE_SEED, mint.toBuffer()],
        program.programId
    )
    const [mintAuthority] = PublicKey.findProgramAddressSync(
        [MINT_AUTHORITY_SEED, mint.toBuffer()],
        program.programId
    )
    const [metadata] = PublicKey.findProgramAddressSync(
        [
            Buffer.from('metadata'),
            METAPLEX_PROGRAM_ID.toBuffer(),
            mint.toBuffer(),
        ],
        METAPLEX_PROGRAM_ID
    )

    const balance = async (pk) =>
        (await connection.getBalance(pk, 'confirmed')) / LAMPORTS_PER_SOL
    const price = async () => {
        const s = await program.account.curveStateAccount.fetch(curveState)
        return {
            price: s.solReserve.div(s.tokenReserve).toString(),
            solReserve: s.solReserve.toString(),
            tokenReserve: s.tokenReserve.toString(),
            supplyOut: s.supplyOut.toString(),
        }
    }

    console.log('=== pumpfun M1 devnet smoke ===')
    console.log('program   :', program.programId.toBase58())
    console.log('creator   :', creator.toBase58())
    console.log('creator SOL:', (await balance(creator)).toFixed(6))
    console.log('nonce     :', nonce.toString())
    console.log('mint      :', mint.toBase58())
    console.log('curve     :', curveState.toBase58())
    console.log('metadata  :', metadata.toBase58())
    console.log('sol_in    :', solIn, 'SOL')
    console.log()

    // 1) create
    const startBalance = await balance(creator)
    const name = 'M1 Smoke'
    const symbol = 'M1S'
    const uri = 'https://example.com/m1-smoke.json'
    const createSig = await program.methods
        .create(nonce, name, symbol, uri)
        .accounts({
            creator,
            mint,
            curveState,
            mintAuthority,
            metadata,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            mplTokenMetadataProgram: METAPLEX_PROGRAM_ID,
            rent: SYSVAR_RENT_PUBKEY,
            sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
        })
        .rpc()
    await connection.confirmTransaction(createSig, 'confirmed')
    const mintInfo = await getMint(
        connection,
        mint,
        'confirmed',
        TOKEN_2022_PROGRAM_ID
    )
    console.log('[create ] tx', createSig)
    console.log(
        '          mint decimals:',
        mintInfo.decimals,
        '| mint authority:',
        mintInfo.mintAuthority?.toBase58(),
        '| freeze:',
        mintInfo.freezeAuthority ?? 'None',
        '| supply:',
        mintInfo.supply.toString()
    )
    console.log('          creator SOL  :', (await balance(creator)).toFixed(6))
    console.log(
        '          vault        :',
        (await balance(curveState)).toFixed(6),
        'SOL'
    )
    const p0 = await price()
    console.log(
        '          price        :',
        p0.price,
        'lamports/token (reserves:',
        p0.solReserve,
        '/',
        p0.tokenReserve,
        ')'
    )
    console.log()

    // 2) buy
    const ata = await getAssociatedTokenAddress(
        mint,
        creator,
        false,
        TOKEN_2022_PROGRAM_ID
    )
    const buySig = await program.methods
        .buy(new BN(solIn * LAMPORTS_PER_SOL))
        .accounts({
            buyer: creator,
            mint,
            curveState,
            buyerAta: ata,
            mintAuthority,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
            associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc()
    await connection.confirmTransaction(buySig, 'confirmed')
    const ataAfterBuy = await getAccount(
        connection,
        ata,
        'confirmed',
        TOKEN_2022_PROGRAM_ID
    )
    const p1 = await price()
    console.log('[buy    ] tx', buySig)
    console.log(
        '          token balance:',
        (Number(ataAfterBuy.amount) / 1e6).toFixed(6),
        'tokens'
    )
    console.log('          creator SOL  :', (await balance(creator)).toFixed(6))
    console.log(
        '          vault        :',
        (await balance(curveState)).toFixed(6),
        'SOL'
    )
    console.log(
        '          price        :',
        p1.price,
        'lamports/token (reserves:',
        p1.solReserve,
        '/',
        p1.tokenReserve,
        ')  [was',
        p0.price,
        ']'
    )
    console.log()

    // 3) sell everything
    const tokenIn = new BN(ataAfterBuy.amount.toString())
    const sellSig = await program.methods
        .sell(tokenIn)
        .accounts({
            seller: creator,
            mint,
            curveState,
            sellerAta: ata,
            systemProgram: SystemProgram.programId,
            token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .rpc()
    await connection.confirmTransaction(sellSig, 'confirmed')
    const ataAfterSell = await getAccount(
        connection,
        ata,
        'confirmed',
        TOKEN_2022_PROGRAM_ID
    )
    const p2 = await price()
    console.log('[sell   ] tx', sellSig)
    console.log('          tokens sold  :', (Number(tokenIn) / 1e6).toFixed(6))
    console.log(
        '          token balance:',
        (Number(ataAfterSell.amount) / 1e6).toFixed(6),
        '(burned)'
    )
    console.log('          creator SOL  :', (await balance(creator)).toFixed(6))
    console.log(
        '          vault        :',
        (await balance(curveState)).toFixed(6),
        'SOL'
    )
    console.log(
        '          price        :',
        p2.price,
        'lamports/token (reserves:',
        p2.solReserve,
        '/',
        p2.tokenReserve,
        ')  [was',
        p1.price,
        ']'
    )
    console.log()
    const endBalance = await balance(creator)
    console.log('=== done ===')
    console.log(
        'net SOL change over create+buy+sell:',
        (endBalance - startBalance).toFixed(6),
        'SOL'
    )
    console.log(
        '  (mint/curve/metadata rents + 1% buy fee + 1% sell fee + tx fees + rounding)'
    )
}

main().catch((e) => {
    console.error(e)
    process.exit(1)
})
