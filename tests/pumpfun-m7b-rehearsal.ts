// Milestone M7b: FULL devnet-rehearsal equivalent for the graduate +
// PumpSwap legs on the LOCAL validator, running the SAME .so that is
// deployed on devnet (BTE4vdMyUSbvgyyutBWYJsrhxj8XtCHQPjMk4Sfin3xu; the M7a
// ELF hash check proved the on-chain ELF equals target/deploy/pumpfun.so).
//
// WHY LOCAL: devnet cannot host this chain. Filling a curve needs 85 SOL of
// real deposits (the devnet faucet caps ~2.5 SOL/day) and PumpSwap is a
// mainnet-only program (tested here via the Anchor.toml fixtures). This file
// rehearses the full product lifecycle in ONE token, end to end:
//
//   create (auto_migrate) -> dev wallets buy -> lib/auto buy round ->
//   lib/auto sell round -> re-buy -> trader FILLS the curve (auto-
//   graduates) -> creator MIGRATES to PumpSwap (lib/migrate) ->
//   sellAllManagedWallets routes to the PumpSwap pool and every dev wallet
//   is sold to 0 tokens with native SOL returned.
//
// The devnet-only legs (launch via Tier 1 sends + auto + curve sell-all)
// are covered by scripts/devnet-rehearsal.mjs against the deployed program;
// together the two prove every path of the milestone's rehearsal list.

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
  TOKEN_PROGRAM_ID,
  ASSOCIATED_TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { expect } from "chai";
import bs58 from "bs58";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Pumpfun } from "../target/types/pumpfun";
import {
  VIRTUAL_SOL_RESERVE,
  GRADUATION_THRESHOLD_SOL,
} from "../lib/params";
import { migrateToPumpSwap, WSOL_MINT } from "../lib/migrate";
import {
  sellAllManagedWallets,
  type SellAllProgram,
  type SellableWallet,
} from "../lib/sell-all";
import {
  fireAutoBuy,
  fireAutoSell,
  readAutoCurveState,
  type AutoWallet,
} from "../lib/auto";
import { walletTokenBalance } from "../lib/bundle/launch";

describe("pumpfun (M7b: full-chain rehearsal: launch -> auto -> sell-all -> graduate -> migrate -> PumpSwap sell-all)", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);
  const program = anchor.workspace.Pumpfun as Program<Pumpfun>;
  const connection = provider.connection;

  const METAPLEX_PROGRAM_ID = new PublicKey(
    "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
  );
  const MINT_SEED = Buffer.from("mint");
  const CURVE_SEED = Buffer.from("curve");
  const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");

  const mintPda = (creator: PublicKey, nonce: BN): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [MINT_SEED, creator.toBuffer(), nonce.toArrayLike(Buffer, "le", 8)],
      program.programId
    );
  const curvePda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [CURVE_SEED, mint.toBuffer()],
      program.programId
    );
  const mintAuthorityPda = (mint: PublicKey): [PublicKey, number] =>
    PublicKey.findProgramAddressSync(
      [MINT_AUTHORITY_SEED, mint.toBuffer()],
      program.programId
    );

  const solInForEffective = (effectiveLamports: bigint): BN => {
    const num = effectiveLamports * 10000n;
    const den = 9900n;
    return new BN(((num + den - 1n) / den).toString());
  };
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
      .create(
        nonce,
        name,
        symbol,
        "https://example.com/m7b-rehearsal.json",
        opts?.autoMigrate ?? true,
        opts?.lockLp ?? true
      )
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

  async function buy(
    buyer: Keypair,
    mint: PublicKey,
    curveState: PublicKey,
    solIn: BN
  ) {
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
        creatorAta: getAssociatedTokenAddressSync(
          mint,
          creator,
          false,
          TOKEN_2022_PROGRAM_ID
        ),
        mintAuthority: mintAuthorityPda(mint)[0],
        systemProgram: SystemProgram.programId,
        token2022Program: TOKEN_2022_PROGRAM_ID,
        associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
      })
      .signers([buyer])
      .rpc();
    await connection.confirmTransaction(sig, "confirmed");
  }

  const sellProgram = program as unknown as SellAllProgram;

  let nonceCounter = 0;
  const NONCE = () => new BN(Date.now() + 400_000 + nonceCounter++);

  before(async () => {
    const bal = await connection.getBalance(creator, "confirmed");
    if (bal < 200 * LAMPORTS_PER_SOL) {
      await airdrop(creator, 200);
    }
  });

  it("full chain: launch + auto engine + curve sell-all, then fill + auto-graduate + migrate + PumpSwap sell-all", async () => {
    const { mint, curveState } = await createToken(
      NONCE(),
      "M7b Full Rehearsal",
      "M7BR",
      { autoMigrate: true, lockLp: true }
    );

    // ---- LAUNCH: dev wallets buy on the open curve ---------------------
    const devs = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const w of devs) {
      await airdrop(w.publicKey, 2);
      await buy(
        w,
        mint,
        curveState,
        solInForEffective(BigInt(Math.floor(0.05 * LAMPORTS_PER_SOL)))
      );
    }
    const wallets: AutoWallet[] = devs.map((w) => ({
      address: w.publicKey.toBase58(),
      key: bs58.encode(w.secretKey),
    }));

    const curveGate = await readAutoCurveState(program, mint);
    expect(curveGate.kind).to.equal("ok");
    if (curveGate.kind !== "ok") return;
    expect(curveGate.curve.graduated).to.equal(false);

    // ---- AUTO BUY round (lib/auto, the browser AUTO engine). A small
    // buyPct keeps each dev position a fraction of a percent of the future
    // pool: concurrent PumpSwap sells at migration stay inside the 5%
    // slippage band (the M6 tests proved big dev buys need sequential
    // sells; the product's AUTO defaults trade small slices).
    const buyRound = await fireAutoBuy({
      connection,
      program,
      mint,
      curve: curveGate.curve,
      wallets,
      minSolLamports: BigInt(0),
      buyPct: 5,
    });
    expect(buyRound.completed).to.equal(3);
    expect(buyRound.failed).to.equal(0);
    for (const w of devs) {
      const t = await walletTokenBalance(connection, w.publicKey, mint);
      expect(t > BigInt(0)).to.equal(true);
    }

    // ---- AUTO SELL round ------------------------------------------------
    const sellRound = await fireAutoSell({
      connection,
      program,
      mint,
      wallets,
      minSellRaw: BigInt(0),
    });
    expect(sellRound.completed).to.equal(3);
    expect(sellRound.failed).to.equal(0);
    for (const w of devs) {
      const t = await walletTokenBalance(connection, w.publicKey, mint);
      expect(t).to.equal(BigInt(0));
    }

    // ---- SELL ALL (curve route) is proven on devnet; here the devs
    // re-buy so the post-graduation PumpSwap sell-all has a balance. -------
    const curveGate2 = await readAutoCurveState(program, mint);
    expect(curveGate2.kind).to.equal("ok");
    if (curveGate2.kind !== "ok") return;
    const rebuy = await fireAutoBuy({
      connection,
      program,
      mint,
      curve: curveGate2.curve,
      wallets,
      minSolLamports: BigInt(0),
      buyPct: 5,
    });
    expect(rebuy.completed).to.equal(3);

    // ---- FILL + AUTO-GRADUATE -------------------------------------------
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));
    const realSol = BigInt(
      (await connection.getBalance(creator, "confirmed")) - creatorSolBefore
    );

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(true);
    expect(realSol > BigInt(Math.floor(50 * LAMPORTS_PER_SOL))).to.equal(true);

    // ---- MIGRATE (lib/migrate, client-driven PumpSwap seed) -------------
    const migrated = await migrateToPumpSwap({
      connection,
      creator: creatorKeypair,
      program,
      mint,
      quoteLamports: realSol,
      index: 0,
    });

    // ---- SELL ALL (PumpSwap route) --------------------------------------
    const roster: SellableWallet[] = devs.map((w) => ({
      address: w.publicKey.toBase58(),
      key: bs58.encode(w.secretKey),
    }));
    const report = await sellAllManagedWallets({
      connection,
      program: sellProgram,
      mint,
      wallets: roster,
      slippagePct: 5,
    });

    console.log(
      "SELL-ALL SUMMARY:",
      JSON.stringify({
        route: report.route,
        graduated: report.graduated,
        sold: report.sold,
        failed: report.failed,
        skipped: report.skipped,
        total: report.total,
        outcomes: report.outcomes.map((o) => ({
          address: o.address,
          route: o.route,
          status: o.status,
          reason: o.reason,
          tokenSold: o.tokenSold.toString(),
          solReceivedLamports: o.solReceivedLamports.toString(),
        })),
      })
    );

    expect(report.route).to.equal("pumpSwap");
    expect(report.graduated).to.equal(true);
    expect(report.poolKey).to.equal(migrated.poolKey.toBase58());
    expect(report.sold).to.equal(3);
    expect(report.failed).to.equal(0);

    for (const o of report.outcomes) {
      const dev = devs.find((w) => w.publicKey.toBase58() === o.address);
      if (!dev) continue;
      expect(o.status).to.equal("sold");
      expect(o.route).to.equal("pumpSwap");
      expect(o.tokenSold > BigInt(0)).to.equal(true);
      expect(o.solReceivedLamports > BigInt(0)).to.equal(true);
      const tokenAfter = await walletTokenBalance(connection, dev.publicKey, mint);
      expect(tokenAfter).to.equal(BigInt(0));
      // The SDK closed the WSOL account in the same tx: no leftover WSOL ATA.
      const wsolAta = getAssociatedTokenAddressSync(
        WSOL_MINT,
        dev.publicKey,
        false,
        TOKEN_PROGRAM_ID
      );
      const wsolInfo = await connection.getAccountInfo(wsolAta, "confirmed");
      expect(wsolInfo).to.equal(null);
    }

    // The migrated pool still holds the remaining base supply (the sell-all
    // moved the devs' tokens into the pool, not out of it).
    const poolBase = await connection.getTokenAccountBalance(
      migrated.poolBaseTokenAccount
    );
    expect(BigInt(poolBase.value.amount) >= migrated.baseAmount).to.equal(true);

    // The dev wallets are no longer holders; only the pool + fill trader hold.
    const holders = await connection.getTokenLargestAccounts(mint, "confirmed");
    const holderAddrs = holders.value
      .filter((a) => BigInt(a.amount) > BigInt(0))
      .map((a) => a.address.toBase58());
    for (const w of devs) {
      expect(holderAddrs.includes(w.publicKey.toBase58())).to.equal(false);
    }
  });
});
