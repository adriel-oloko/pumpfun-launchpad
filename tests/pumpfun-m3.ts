// Milestone M3: graduation / client-driven PumpSwap migration tests.
//
// Runs against the local validator with the PumpSwap program + its
// global_config injected from mainnet dumps (see Anchor.toml + tests/fixtures;
// the programdata's deployment-slot field is patched to 0 so the local
// validator treats it as effective). Devnet has no PumpSwap; the migration
// proof lives here, on the local validator.
//
// Tests:
//   1. create(auto_migrate=false) -> fill -> graduate (creator-only) -> the
//      creator receives the real SOL + remaining supply; the curve is flagged
//      graduated; buy and sell revert afterwards; nothing is stranded.
//   2. graduate below the threshold reverts.
//   3. graduate by a non-creator reverts.
//   4. create(auto_migrate=true) -> the fill buy graduates the curve in the
//      same instruction, no separate call.
//   5. Migration script: SDK createPool seeds a real PumpSwap pool with the
//      correct WSOL and token reserves; with lock_lp=true the LP is burned
//      (locked); a follow-up deposit works.
//   6. Migration with lock_lp=false leaves the LP under the creator.

import * as anchor from "@coral-xyz/anchor";
import { Program, BN } from "@coral-xyz/anchor";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  SYSVAR_INSTRUCTIONS_PUBKEY,
} from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
  getMint,
  getAccount,
} from "@solana/spl-token";
import { expect } from "chai";
import type { Pumpfun } from "../target/types/pumpfun";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  TOTAL_SUPPLY,
  VIRTUAL_SOL_RESERVE,
  GRADUATION_THRESHOLD_SOL,
} from "../lib/params";
import {
  migrateToPumpSwap,
  depositToPool,
} from "../lib/migrate";

describe("pumpfun (M3: graduation + client-driven PumpSwap migration)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Pumpfun as Program<Pumpfun>;
  const connection = provider.connection;

  const METAPLEX_PROGRAM_ID = new PublicKey("metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s");

  const MINT_SEED = Buffer.from("mint");
  const CURVE_SEED = Buffer.from("curve");
  const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");
  const SOL = new BN(LAMPORTS_PER_SOL);

  const mintPda = (creator: PublicKey, nonce: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [MINT_SEED, creator.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  const curvePda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([CURVE_SEED, mint.toBuffer()], program.programId);
  const mintAuthorityPda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync([MINT_AUTHORITY_SEED, mint.toBuffer()], program.programId);

  // buy input for a target *effective* amount: effective = in * 9900 / 10000,
  // so in = ceil(target * 10000 / 9900).
  const solInForEffective = (effectiveLamports: bigint): BN => {
    const num = effectiveLamports * 10000n;
    const den = 9900n;
    return new BN(((num + den - 1n) / den).toString());
  };
  // 55 SOL effective fills the curve exactly (30 virtual + 55 = 85 >= threshold).
  const FILL_EFFECTIVE = GRADUATION_THRESHOLD_SOL - VIRTUAL_SOL_RESERVE;

  const creatorKeypair = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(
        fs.readFileSync(
          path.join(os.homedir(), ".config", "solana", "devnet.json"),
          "utf8"
        )
      )
    )
  );
  const creator = provider.wallet.publicKey;

  async function airdrop(to: PublicKey, sol: number) {
    const sig = await connection.requestAirdrop(to, sol * LAMPORTS_PER_SOL);
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function createToken(
    nonce: BN,
    name: string,
    symbol: string,
    uri: string,
    opts?: { autoMigrate?: boolean; lockLp?: boolean }
  ) {
    const [mint] = mintPda(creator, nonce);
    const [curveState] = curvePda(mint);
    const [mintAuthority] = mintAuthorityPda(mint);
    const metadata = PublicKey.findProgramAddressSync(
      [Buffer.from("metadata"), METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      METAPLEX_PROGRAM_ID
    )[0];
    const sig = await program.methods
      .create(nonce, name, symbol, uri, opts?.autoMigrate ?? true, opts?.lockLp ?? true)
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
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
    return { creator, mint, curveState, mintAuthority };
  }

  async function buy(buyer: Keypair, mint: PublicKey, curveState: PublicKey, solIn: BN) {
    const buyerAta = await getAssociatedTokenAddress(
      mint,
      buyer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const sig = await program.methods
      .buy(solIn)
      .accounts({
        buyer: buyer.publicKey,
        mint,
        curveState,
        buyerAta,
        creatorAccount: creator,
        creatorAta: getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID),
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
  }

  async function graduate(mint: PublicKey, curveState: PublicKey, signer: Keypair) {
    const creatorAta = getAssociatedTokenAddressSync(
      mint,
      signer.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const sig = await program.methods
      .graduate()
      .accounts({
        creator: signer.publicKey,
        mint,
        curveState,
        creatorAta,
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers(signer.publicKey === creator ? [] : [signer])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
  }

  let nonceCounter = 0;
  const NONCE = () => new BN(Date.now() + 100_000 + nonceCounter++);

  before(async () => {
    // The provider wallet is the token creator for every test; make sure it
    // can fund the WSOL wrap + LP burn txs in the migration tests.
    const bal = await connection.getBalance(creator, "confirmed");
    if (bal < 200 * LAMPORTS_PER_SOL) {
      await airdrop(creator, 200);
    }
  });

  it("manual graduate: creator-only, releases real SOL + remaining supply, flags graduated, buy/sell revert, nothing stranded", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Manual Grad", "MG", "https://example.com/mg.json", {
      autoMigrate: false,
      lockLp: true,
    });

    // Fill the curve to the threshold (55 SOL effective) with a trader.
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(false);
    expect(state.autoMigrate).to.equal(false);
    expect(state.lockLp).to.equal(true);
    expect(state.creator.toString()).to.equal(creator.toString());
    expect(Number(state.solReserve.toString())).to.be.greaterThanOrEqual(Number(GRADUATION_THRESHOLD_SOL.toString()));

    // real_sol = vault lamports - rent-exempt floor (M7a F1 fix: the vault
    // only ever held real buyer lamports, never the 30 SOL virtual reserve,
    // so graduation releases every real lamport above the rent floor).
    const vaultInfo = (await connection.getAccountInfo(curveState))!;
    const vaultBefore = BigInt(vaultInfo.lamports);
    const rentMin = await connection.getMinimumBalanceForRentExemption(
      vaultInfo.data.length
    );
    const realSol = vaultBefore - BigInt(rentMin);
    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    const creatorAta = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);

    await graduate(mint, curveState, creatorKeypair);

    // Graduated flag set; the vault keeps exactly its rent-exempt floor
    // (M7a F1: the full real deposits went to the creator, nothing stranded).
    const after = await program.account.curveStateAccount.fetch(curveState);
    expect(after.graduated).to.equal(true);
    expect((await connection.getAccountInfo(curveState))!.lamports).to.equal(
      rentMin
    );

    // The creator received the real SOL (minus their own tx fee).
    const creatorSolAfter = await connection.getBalance(creator, "confirmed");
    const delta = BigInt(creatorSolAfter - creatorSolBefore);
    // The creator received the real SOL, minus their own costs (the graduate
    // tx fee + the on-demand ATA creation rent, ~0.002 SOL total).
    expect(delta <= realSol).to.equal(true);
    expect(delta >= realSol - 3_000_000n).to.equal(true);

    // Remaining supply minted to the creator's ATA; mint authority revoked;
    // the full supply is out (nothing stranded in program accounts).
    const remaining = TOTAL_SUPPLY - BigInt(after.supplyOut.toString());
    const creatorAtaInfo = await getAccount(connection, creatorAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(creatorAtaInfo.amount.toString()).to.equal(remaining.toString());
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(mintInfo.mintAuthority).to.be.null;
    expect(mintInfo.supply.toString()).to.equal(TOTAL_SUPPLY.toString());

    // Trading is closed after graduation.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let buyThrown: any;
    try {
      await buy(trader, mint, curveState, SOL);
    } catch (e) {
      buyThrown = e;
    }
    expect(buyThrown).to.exist;
    expect(anchor.AnchorError.parse(buyThrown.logs)!.error.errorCode.code).to.equal("AlreadyGraduated");

    const traderAta = await getAssociatedTokenAddress(mint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let sellThrown: any;
    try {
      await program.methods
        .sell(new BN(1))
        .accounts({
          seller: trader.publicKey,
          mint,
          curveState,
          sellerAta: traderAta,
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
        })
        .signers([trader])
        .rpc();
    } catch (e) {
      sellThrown = e;
    }
    expect(sellThrown).to.exist;
    expect(anchor.AnchorError.parse(sellThrown.logs)!.error.errorCode.code).to.equal("AlreadyGraduated");
  });

  it("graduate below the graduation threshold reverts", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Below Grad", "BG", "https://example.com/bg.json", {
      autoMigrate: false,
      lockLp: true,
    });
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    // 54 SOL effective: reserve = 84 SOL < 85 threshold.
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE - BigInt(SOL.toNumber())));

    const creatorAta = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await program.methods
        .graduate()
        .accounts({
          creator,
          mint,
          curveState,
          creatorAta,
          mintAuthority: mintAuthorityPda(mint)[0],
          systemProgram: SystemProgram.programId,
          token2022Program: TOKEN_2022_PROGRAM_ID,
          associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
        })
        .rpc();
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;
    expect(anchor.AnchorError.parse(thrown.logs)!.error.errorCode.code).to.equal("BelowGraduationThreshold");

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(false);
  });

  it("graduate by a non-creator reverts", async () => {
    const { mint, curveState } = await createToken(NONCE(), "NonCreator", "NC", "https://example.com/nc.json", {
      autoMigrate: false,
      lockLp: true,
    });
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));

    const attacker = Keypair.generate();
    await airdrop(attacker.publicKey, 10);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await graduate(mint, curveState, attacker);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;
    expect(anchor.AnchorError.parse(thrown.logs)!.error.errorCode.code).to.equal("NotCurveCreator");
    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(false);
  });

  it("auto-graduate: the fill buy graduates the curve in the same instruction, no separate call", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Auto Grad", "AG", "https://example.com/ag.json", {
      autoMigrate: true,
      lockLp: true,
    });
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);

    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    const creatorAta = getAssociatedTokenAddressSync(mint, creator, false, TOKEN_2022_PROGRAM_ID);

    // The single fill buy both succeeds (buyer gets tokens) and graduates.
    // The buyer pays the tx fee and the creator's ATA rent, so the creator's
    // balance moves by exactly the released real SOL.
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));
    const realSol = BigInt((await connection.getBalance(creator, "confirmed")) - creatorSolBefore);
    expect(realSol > 0n).to.equal(true);

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(true);
    // The vault keeps exactly its rent-exempt floor (M7a F1): the auto path
    // releases the same real deposits as the manual graduate.
    const vaultAfterInfo = (await connection.getAccountInfo(curveState))!;
    const rentMin = await connection.getMinimumBalanceForRentExemption(
      vaultAfterInfo.data.length
    );
    expect(vaultAfterInfo.lamports).to.equal(rentMin);
    // Buyer got their tokens; creator got the real SOL + remaining supply;
    // mint authority revoked.
    const traderAta = await getAssociatedTokenAddress(mint, trader.publicKey, false, TOKEN_2022_PROGRAM_ID);
    const traderBal = await getAccount(connection, traderAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(Number(traderBal.amount.toString())).to.be.greaterThan(0);
    const creatorSolAfter = await connection.getBalance(creator, "confirmed");
    // The buyer paid the tx fee, so the creator's delta is exactly real_sol.
    expect(BigInt(creatorSolAfter - creatorSolBefore)).to.equal(realSol);

    const remaining = TOTAL_SUPPLY - BigInt(state.supplyOut.toString());
    const creatorAtaInfo = await getAccount(connection, creatorAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(creatorAtaInfo.amount.toString()).to.equal(remaining.toString());
    const mintInfo = await getMint(connection, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(mintInfo.mintAuthority).to.be.null;
    expect(mintInfo.supply.toString()).to.equal(TOTAL_SUPPLY.toString());

    // A follow-up buy reverts.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- captures the thrown anchor error, shape is opaque to the test
    let thrown: any;
    try {
      await buy(trader, mint, curveState, SOL);
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.exist;
    expect(anchor.AnchorError.parse(thrown.logs)!.error.errorCode.code).to.equal("AlreadyGraduated");
  });

  it("migration script: SDK createPool seeds a PumpSwap pool with correct reserves; lock_lp=true burns the LP; deposit works", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Migrate Lock", "ML", "https://example.com/ml.json", {
      autoMigrate: true,
      lockLp: true,
    });
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    // A future LP depositor buys base on the curve before graduation (same
    // mint, so after migration those tokens are the pool's base tokens).
    const depositor = Keypair.generate();
    await airdrop(depositor.publicKey, 100);
    await buy(depositor, mint, curveState, new BN(Math.floor(0.2 * LAMPORTS_PER_SOL)));
    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));
    // Auto path: the buyer paid the fee, so the creator's balance delta is
    // exactly the released real SOL.
    const realSol = BigInt((await connection.getBalance(creator, "confirmed")) - creatorSolBefore);

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(true);
    const remaining = TOTAL_SUPPLY - BigInt(state.supplyOut.toString());

    // The client-driven migration: wrap the real SOL, SDK createPool with the
    // remaining supply, burn the LP (lock_lp=true from the curve).
    const result = await migrateToPumpSwap({
      connection,
      creator: creatorKeypair,
      program,
      mint,
      quoteLamports: realSol,
      index: 0,
    });

    // Pool exists with the exact released reserves.
    expect(result.baseAmount).to.equal(remaining);
    expect(result.quoteAmount).to.equal(realSol);
    expect(result.lpLocked).to.equal(true);
    expect(result.creatorLpBalance).to.equal(0n);

    const poolBaseBal = await connection.getTokenAccountBalance(result.poolBaseTokenAccount);
    const poolQuoteBal = await connection.getTokenAccountBalance(result.poolQuoteTokenAccount);
    expect(poolBaseBal.value.amount).to.equal(remaining.toString());
    expect(poolQuoteBal.value.amount).to.equal(realSol.toString());

    // LP mint authority is the pool PDA (the real pump.fun layout); the LP
    // itself is burned, so no one can withdraw.
    const lpMintInfo = await getMint(connection, result.lpMint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(lpMintInfo.mintAuthority!.toString()).to.equal(result.poolKey.toString());
    expect(lpMintInfo.supply.toString()).to.equal("0");

    // Post-migration deposit: the depositor holds base from their curve buy;
    // they add liquidity to the pool through the SDK.
    const depositorBaseAta = getAssociatedTokenAddressSync(
      mint,
      depositor.publicKey,
      false,
      TOKEN_2022_PROGRAM_ID
    );
    const depositorBal = await getAccount(connection, depositorBaseAta, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(BigInt(depositorBal.amount.toString()) >= 5_000_000n).to.equal(true);

    const baseIn = 5_000_000n;
    const expectedQuote = (baseIn * realSol) / remaining;
    const deposit = await depositToPool(connection, result.poolKey, depositor, baseIn, 1);
    expect(deposit.poolBaseReserve).to.equal(remaining + baseIn);
    // The SDK deposits base + a WSOL amount within the slippage band.
    expect(deposit.quoteIn <= expectedQuote + (expectedQuote * 10n) / 100n).to.equal(true);
    expect(deposit.quoteIn >= expectedQuote - (expectedQuote * 10n) / 100n).to.equal(true);
    expect(deposit.poolQuoteReserve).to.equal(realSol + deposit.quoteIn);
    expect(deposit.lpOut > 0n).to.equal(true);
    const depositorLp = await connection.getTokenAccountBalance(
      getAssociatedTokenAddressSync(result.lpMint, depositor.publicKey, true, TOKEN_2022_PROGRAM_ID)
    );
    expect(depositorLp.value.amount).to.equal(deposit.lpOut.toString());
  });

  it("migration with lock_lp=false leaves the LP under the creator", async () => {
    const { mint, curveState } = await createToken(NONCE(), "Migrate NoLock", "MN", "https://example.com/mn.json", {
      autoMigrate: true,
      lockLp: false,
    });
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));
    const realSol = BigInt((await connection.getBalance(creator, "confirmed")) - creatorSolBefore);

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(true);
    expect(state.lockLp).to.equal(false);

    const result = await migrateToPumpSwap({
      connection,
      creator: creatorKeypair,
      program,
      mint,
      quoteLamports: realSol,
      index: 0,
    });

    expect(result.lpLocked).to.equal(false);
    // LP stays under the creator: they can remove liquidity later.
    expect(result.creatorLpBalance > 0n).to.equal(true);
    const lpMintInfo = await getMint(connection, result.lpMint, "confirmed", TOKEN_2022_PROGRAM_ID);
    expect(lpMintInfo.mintAuthority!.toString()).to.equal(result.poolKey.toString());
    expect(lpMintInfo.supply.toString()).to.equal(result.creatorLpBalance.toString());
  });
});
