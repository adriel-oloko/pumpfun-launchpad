// Milestone M6: SELL ALL tests.
//
// Runs against the local validator with the PumpSwap program + its
// global_config injected from mainnet dumps (see Anchor.toml + tests/fixtures),
// exactly like the M3 migration tests. Two routes are exercised:
//
//   1. CURVE (not graduated): several dev wallets buy on the open curve,
//      then sellAllManagedWallets sells every keyed wallet's full balance
//      through the program's sell instruction. All balances go to zero, each
//      wallet receives native SOL, and the holder count collapses to zero.
//   2. PUMSWAP (graduated): dev wallets buy pre-graduation, a trader fills
//      the curve (auto-graduates), the creator migrates to PumpSwap, then
//      sellAllManagedWallets swaps each wallet's full balance on the pool.
//      The SDK closes the WSOL account in the same tx, so every wallet ends
//      with native SOL and no leftover WSOL ATA.
//
// This is the M6 graduated-path proof: devnet has no PumpSwap, so the
// graduated sell leg can only be verified on the local validator.

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
import { walletTokenBalance } from "../lib/bundle/launch";

describe("pumpfun (M6: sell all - curve + PumpSwap routing)", () => {
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

  // buy input for a target *effective* amount (effective = in * 9900 / 10000).
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
      .create(
        nonce,
        name,
        symbol,
        uri,
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
  const NONCE = () => new BN(Date.now() + 200_000 + nonceCounter++);

  before(async () => {
    const bal = await connection.getBalance(creator, "confirmed");
    if (bal < 200 * LAMPORTS_PER_SOL) {
      await airdrop(creator, 200);
    }
  });

  it("sell all (curve route): every keyed wallet's balance goes to zero, wallets receive SOL, holders collapse", async () => {
    const { mint, curveState } = await createToken(
      NONCE(),
      "SellAll Curve",
      "SAC",
      "https://example.com/sac.json",
      { autoMigrate: false, lockLp: true }
    );

    // Three dev wallets buy small amounts on the open curve; a fourth keyed
    // wallet is funded but never buys (zero balance -> skipped); a watch-only
    // entry (no key) is skipped too.
    const devs = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    const zeroKeyed = Keypair.generate();
    for (const w of [devs[0], devs[1], devs[2], zeroKeyed]) {
      await airdrop(w.publicKey, 2);
    }
    const buyLamports = BigInt(Math.floor(0.05 * LAMPORTS_PER_SOL));
    const preBalances = new Map<string, bigint>();
    for (const w of devs) {
      await buy(w, mint, curveState, solInForEffective(buyLamports));
      preBalances.set(
        w.publicKey.toBase58(),
        await walletTokenBalance(connection, w.publicKey, mint)
      );
    }
    for (const bal of preBalances.values()) {
      expect(bal > BigInt(0)).to.equal(true);
    }

    const curve = await program.account.curveStateAccount.fetch(curveState);
    expect(curve.graduated).to.equal(false);

    const roster: SellableWallet[] = [
      ...devs.map((w) => ({
        address: w.publicKey.toBase58(),
        key: bs58.encode(w.secretKey),
      })),
      { address: zeroKeyed.publicKey.toBase58(), key: bs58.encode(zeroKeyed.secretKey) },
      { address: creator.toBase58(), key: undefined },
    ];

    const report = await sellAllManagedWallets({
      connection,
      program: sellProgram,
      mint,
      wallets: roster,
      slippagePct: 5,
    });

    // ROUTING: not graduated -> curve sells.
    expect(report.route).to.equal("curve");
    expect(report.graduated).to.equal(false);
    expect(report.sold).to.equal(3);
    expect(report.failed).to.equal(0);
    // zero-token keyed wallet + watch-only wallet skipped.
    expect(report.skipped).to.equal(2);
    expect(report.total).to.equal(5);

    for (const o of report.outcomes) {
      const dev = devs.find((w) => w.publicKey.toBase58() === o.address);
      if (dev) {
        expect(o.status).to.equal("sold");
        expect(o.route).to.equal("curve");
        expect(o.tokenSold).to.equal(preBalances.get(o.address) ?? BigInt(0));
        expect(o.solReceivedLamports > BigInt(0)).to.equal(true);
        expect(typeof o.signature).to.equal("string");
        // Balance is now zero on chain.
        const after = await walletTokenBalance(connection, dev.publicKey, mint);
        expect(after).to.equal(BigInt(0));
      }
    }
    // Wallets received native SOL (measured independently of the report).
    for (const w of devs) {
      const solBal = await connection.getBalance(w.publicKey, "confirmed");
      expect(solBal).to.be.greaterThan(0);
    }

    // Holder count collapses to zero: every dev token was burned by the
    // curve sells and nobody else holds the mint.
    expect(report.holderCountAfter).to.equal(0);
  });

  it("sell all (PumpSwap route): graduated wallet sells swap on the pool and WSOL unwraps to native SOL", async () => {
    const { mint, curveState } = await createToken(
      NONCE(),
      "SellAll Swap",
      "SAS",
      "https://example.com/sas.json",
      { autoMigrate: true, lockLp: true }
    );

    // Dev wallets buy small amounts BEFORE the curve fills.
    const devs = [Keypair.generate(), Keypair.generate(), Keypair.generate()];
    for (const w of devs) {
      await airdrop(w.publicKey, 2);
      await buy(
        w,
        mint,
        curveState,
        solInForEffective(BigInt(Math.floor(0.05 * LAMPORTS_PER_SOL)))
      );
      const bal = await walletTokenBalance(connection, w.publicKey, mint);
      expect(bal > BigInt(0)).to.equal(true);
    }

    // Fill the curve with a trader: the fill buy auto-graduates (auto_migrate).
    const trader = Keypair.generate();
    await airdrop(trader.publicKey, 100);
    const creatorSolBefore = await connection.getBalance(creator, "confirmed");
    await buy(trader, mint, curveState, solInForEffective(FILL_EFFECTIVE));
    const realSol = BigInt(
      (await connection.getBalance(creator, "confirmed")) - creatorSolBefore
    );

    const state = await program.account.curveStateAccount.fetch(curveState);
    expect(state.graduated).to.equal(true);

    // Client-driven migration seeds the PumpSwap pool (M3 path).
    const migrated = await migrateToPumpSwap({
      connection,
      creator: creatorKeypair,
      program,
      mint,
      quoteLamports: realSol,
      index: 0,
    });

    const roster: SellableWallet[] = devs.map((w) => ({
      address: w.publicKey.toBase58(),
      key: bs58.encode(w.secretKey),
    }));

    const holdersBefore = await countHolders(mint);

    const report = await sellAllManagedWallets({
      connection,
      program: sellProgram,
      mint,
      wallets: roster,
      slippagePct: 5,
    });

    // ROUTING: graduated -> PumpSwap swap against the migrated pool.
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

      // Token balance is zero after the pool swap.
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

    // The dev wallets stopped being holders; the pool (base reserve) and the
    // fill trader remain, so the holder count drops by exactly the sold devs.
    const holdersAfter = report.holderCountAfter;
    expect(holdersAfter).to.not.equal(null);
    expect(holdersAfter! <= holdersBefore - 3).to.equal(true);
    // The migrated pool still holds the remaining base supply.
    const poolBase = await connection.getTokenAccountBalance(
      migrated.poolBaseTokenAccount
    );
    expect(BigInt(poolBase.value.amount) >= migrated.baseAmount).to.equal(true);
  });

  async function countHolders(mint: PublicKey): Promise<number> {
    const r = await connection.getTokenLargestAccounts(mint, "confirmed");
    return r.value.filter((a) => BigInt(a.amount) > BigInt(0)).length;
  }
});
