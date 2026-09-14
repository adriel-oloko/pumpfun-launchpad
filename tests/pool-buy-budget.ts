// Offline regression test for the manual BUY MAX on the MIGRATED venue.
//
// A graduated mint (curve `complete` = 1) has no tradable curve left: the
// curve buy reverts on-chain, so the manual round routes to the canonical
// PumpSwap pool (lib/batch-trade.ts `buySelectedWalletsMigrated`). This suite
// pins the things that decide whether that buy can land at all:
//
//   1. the MAX budget rule — total balance minus the flat 0.002 SOL keep, the
//      5,000-lamport base fee, and ONLY the rents the tx must actually create.
//      That figure is what the tx wraps as WSOL and spends in full
//      (buy_exact_quote_in since 2026-09-14), so it is exactly the wallet's
//      whole spendable balance: the wallet must end at its keep, never below.
//   2. the exact-in rewrite — the SDK's `buy(base_amount_out,
//      max_quote_amount_in)` becomes `buy_exact_quote_in(spendable_quote_in,
//      min_base_amount_out)` with the band as a FLOOR on the tokens received.
//   3. the pre-flight — a mint flagged graduated with no pool behind it fails
//      the run with a clean error instead of firing N wallets at a dead pool.
//
// No network, no keys.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pool-buy-budget.ts"

import { expect } from "chai";
import { Buffer } from "buffer";
import { PUMP_AMM_PROGRAM_ID } from "@pump-fun/pump-swap-sdk";
import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  buySelectedWalletsMigrated,
  poolBuyBudgetLamports,
} from "../lib/batch-trade";
import { MAX_BUY_KEEP_SOL_LAMPORTS } from "../lib/params";
import {
  POOL_BUY_SLIPPAGE_PCT,
  poolBuyMinBaseOut,
  toExactQuoteInBuy,
} from "../lib/swap";

/** The flat keep after a MAX buy (lib/params.ts). */
const KEEP = BigInt(2_000_000);
/** Single-signer legacy tx base fee. */
const FEE = BigInt(5_000);
/** Rent for 170 bytes (a Token-2022 ATA) / 165 bytes (a WSOL ATA), as the LIVE
 *  Rent sysvar reports it: lamportsPerByteYear = 5080, exemptionThreshold = 0
 *  (read on two independent mainnet RPCs, Sep 2026; the classic 3480
 *  lamports-per-byte-year schedule gives 2_074_080 / 2_039_280 and is stale).
 *  These are fixture numbers only: the code reads the live rents from the RPC
 *  at run time. */
const BASE_ATA_RENT = BigInt(1_513_840);
const WSOL_ATA_RENT = BigInt(1_488_440);
const ONE_SOL = BigInt(1_000_000_000);

/** The real graduated mint + its canonical PumpSwap pool, used for the
 *  pre-flight assertions (no RPC is made: the pool read is stubbed). */
const MINT = new PublicKey("5LPRbTRqc37wWt6kGeyLgitnxrTFQBLfyK4D8aVMpump");
const POOL = new PublicKey("2s6B6mKgiCwB5qBofuxTFkmRS68pgRAeFe5MSca47tuP");

describe("poolBuyBudgetLamports (MAX budget on the pool venue)", () => {
  it("spends the total balance minus the flat keep and the base fee when both ATAs exist", () => {
    expect(
      poolBuyBudgetLamports({
        liveLamports: ONE_SOL,
        baseAtaRentLamports: BigInt(0),
        wsolAtaRentLamports: BigInt(0),
      })
    ).to.equal(ONE_SOL - KEEP - FEE);
  });

  it("reserves the base-ATA rent exactly when that ATA is missing", () => {
    const withAta = poolBuyBudgetLamports({
      liveLamports: ONE_SOL,
      baseAtaRentLamports: BigInt(0),
      wsolAtaRentLamports: WSOL_ATA_RENT,
    });
    const withoutAta = poolBuyBudgetLamports({
      liveLamports: ONE_SOL,
      baseAtaRentLamports: BASE_ATA_RENT,
      wsolAtaRentLamports: WSOL_ATA_RENT,
    });
    expect(withAta - withoutAta).to.equal(BASE_ATA_RENT);
  });

  it("reserves the WSOL rent too (the SDK creates and closes that account in the buy tx)", () => {
    const withWsol = poolBuyBudgetLamports({
      liveLamports: ONE_SOL,
      baseAtaRentLamports: BASE_ATA_RENT,
      wsolAtaRentLamports: BigInt(0),
    });
    const withoutWsol = poolBuyBudgetLamports({
      liveLamports: ONE_SOL,
      baseAtaRentLamports: BASE_ATA_RENT,
      wsolAtaRentLamports: WSOL_ATA_RENT,
    });
    expect(withWsol - withoutWsol).to.equal(WSOL_ATA_RENT);
  });

  it("keeps the SAME 0.002 SOL keep and 5,000-lamport fee as the curve leg", () => {
    expect(MAX_BUY_KEEP_SOL_LAMPORTS).to.equal(KEEP);
    // Exactly the keep + fee leaves nothing to spend: the wallet is skipped.
    expect(
      poolBuyBudgetLamports({
        liveLamports: KEEP + FEE,
        baseAtaRentLamports: BigInt(0),
        wsolAtaRentLamports: BigInt(0),
      })
    ).to.equal(BigInt(0));
    // One lamport more buys exactly one lamport more.
    expect(
      poolBuyBudgetLamports({
        liveLamports: KEEP + FEE + BigInt(1),
        baseAtaRentLamports: BigInt(0),
        wsolAtaRentLamports: BigInt(0),
      })
    ).to.equal(BigInt(1));
  });

  it("never returns a negative budget (dust wallets are skipped, never overdrawn)", () => {
    expect(
      poolBuyBudgetLamports({
        liveLamports: KEEP,
        baseAtaRentLamports: BASE_ATA_RENT,
        wsolAtaRentLamports: WSOL_ATA_RENT,
      })
    ).to.equal(BigInt(0));
    expect(
      poolBuyBudgetLamports({
        liveLamports: BigInt(0),
        baseAtaRentLamports: BASE_ATA_RENT,
        wsolAtaRentLamports: WSOL_ATA_RENT,
      })
    ).to.equal(BigInt(0));
  });

  it("accounts for every lamport: budget + keep + fee + rents = the live balance", () => {
    const live = BigInt(100_000_000); // 0.1 SOL
    const budget = poolBuyBudgetLamports({
      liveLamports: live,
      baseAtaRentLamports: BASE_ATA_RENT,
      wsolAtaRentLamports: WSOL_ATA_RENT,
    });
    expect(budget + KEEP + FEE + BASE_ATA_RENT + WSOL_ATA_RENT).to.equal(live);
  });
});

describe("poolBuyMinBaseOut (the band's floor on the tokens received)", () => {
  it("at the venue band (20%) the floor is 80% of the quoted base", () => {
    expect(POOL_BUY_SLIPPAGE_PCT).to.equal(20);
    expect(poolBuyMinBaseOut(BigInt(1_000_000_000), POOL_BUY_SLIPPAGE_PCT)).to.equal(
      BigInt(800_000_000)
    );
  });

  it("0% pins the floor to the quote; 100% pins it to zero", () => {
    expect(poolBuyMinBaseOut(BigInt(1_000_000_000), 0)).to.equal(
      BigInt(1_000_000_000)
    );
    expect(poolBuyMinBaseOut(BigInt(1_000_000_000), 100)).to.equal(BigInt(0));
  });

  it("refuses a band outside [0, 100] instead of clamping it", () => {
    expect(() => poolBuyMinBaseOut(BigInt(1), -1)).to.throw(
      /outside the allowed range/
    );
    expect(() => poolBuyMinBaseOut(BigInt(1), 101)).to.throw(
      /outside the allowed range/
    );
  });
});

describe("toExactQuoteInBuy (the SDK's buy -> buy_exact_quote_in)", () => {
  // The two discriminators, straight from the pump_amm IDL.
  const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);
  const EXACT_IN_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

  /** The SDK's own buy instruction shape: disc ++ u64 ++ u64 ++ OptionBool. */
  function sdkBuyIx(
    baseOut: bigint,
    maxQuoteIn: bigint
  ): TransactionInstruction {
    const data = Buffer.alloc(25);
    BUY_DISC.copy(data, 0);
    data.writeBigUInt64LE(baseOut, 8);
    data.writeBigUInt64LE(maxQuoteIn, 16);
    data[24] = 1; // track_volume = OptionBool some(true)
    return new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [],
      data,
    });
  }

  it("swaps the discriminator and both args, keeps track_volume and the accounts", () => {
    const ix = sdkBuyIx(BigInt(123), BigInt(456));
    const out = toExactQuoteInBuy(ix, BigInt(1_000_000), BigInt(800_000));
    expect(out.programId.toBase58()).to.equal(PUMP_AMM_PROGRAM_ID.toBase58());
    expect(out.keys).to.equal(ix.keys);
    const data = Buffer.from(out.data);
    expect(data.length).to.equal(25);
    expect(data.subarray(0, 8).equals(EXACT_IN_DISC)).to.equal(true);
    expect(data.readBigUInt64LE(8)).to.equal(BigInt(1_000_000));
    expect(data.readBigUInt64LE(16)).to.equal(BigInt(800_000));
    expect(data[24]).to.equal(1);
  });

  it("does not mutate the instruction it was handed", () => {
    const ix = sdkBuyIx(BigInt(123), BigInt(456));
    toExactQuoteInBuy(ix, BigInt(1_000_000), BigInt(800_000));
    const original = Buffer.from(ix.data);
    expect(original.subarray(0, 8).equals(BUY_DISC)).to.equal(true);
    expect(original.readBigUInt64LE(8)).to.equal(BigInt(123));
    expect(original.readBigUInt64LE(16)).to.equal(BigInt(456));
  });

  it("refuses anything that is not a 25-byte pump_amm buy", () => {
    // A sell (24-byte data) must never be rewritten into a buy.
    const sell = new TransactionInstruction({
      programId: PUMP_AMM_PROGRAM_ID,
      keys: [],
      data: Buffer.alloc(24),
    });
    expect(() => toExactQuoteInBuy(sell, BigInt(1), BigInt(1))).to.throw(
      /25-byte pump_amm buy/
    );
    // Same size, different program/discriminator: refused too.
    const other = new TransactionInstruction({
      programId: SystemProgram.programId,
      keys: [],
      data: Buffer.alloc(25),
    });
    expect(() => toExactQuoteInBuy(other, BigInt(1), BigInt(1))).to.throw(
      /not a pump_amm buy/
    );
  });
});

describe("buySelectedWalletsMigrated pre-flight", () => {
  it("returns zeros for zero wallets without touching the Connection", async () => {
    // A stub connection would throw TypeError on any method access, so the
    // empty batch must short-circuit before the first RPC.
    const result = await buySelectedWalletsMigrated({
      connection: {} as never,
      mint: MINT,
      poolKey: POOL,
      wallets: [],
    });
    expect(result).to.deep.equal({
      completed: 0,
      failed: 0,
      skipped: 0,
      signatures: [],
    });
  });

  it("fails the whole run with a clean error when the pool account is missing", async () => {
    // The wallet key is deliberately junk: the pre-flight must fail BEFORE any
    // wallet is decoded or any buy is attempted (bs58.decode would throw on it).
    const stub = {
      getAccountInfo: async () => null,
    } as unknown as Connection;
    let thrown: unknown = null;
    try {
      await buySelectedWalletsMigrated({
        connection: stub,
        mint: MINT,
        poolKey: POOL,
        wallets: [{ address: MINT.toBase58(), key: "not-base58" }],
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "expected the promise to reject").to.not.equal(null);
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).to.match(/PUMPSWAP POOL/);
    expect(msg).to.match(/NOT FOUND \(NOT MIGRATED\?\)/);
    expect(msg).to.not.match(/base58/i);
  });
});
