// Offline regression test for the manual BUY MAX on the MIGRATED venue.
//
// A graduated mint (curve `complete` = 1) has no tradable curve left: the
// curve buy reverts on-chain, so the manual round routes to the canonical
// PumpSwap pool (lib/batch-trade.ts `buySelectedWalletsMigrated`). This suite
// pins the two things that decide whether that buy can land at all:
//
//   1. the MAX budget rule — total balance minus the flat 0.002 SOL keep, the
//      5,000-lamport base fee, and ONLY the rents the tx must actually create.
//      That figure is what the SDK wraps as WSOL (`maxQuoteAmountIn` at zero
//      slippage), so it is exactly the wallet's whole spendable balance: the
//      wallet must end at its keep, never below it.
//   2. the pre-flight — a mint flagged graduated with no pool behind it fails
//      the run with a clean error instead of firing N wallets at a dead pool.
//
// No network, no keys.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pool-buy-budget.ts"

import { expect } from "chai";
import { Connection, PublicKey } from "@solana/web3.js";
import {
  buySelectedWalletsMigrated,
  poolBuyBudgetLamports,
} from "../lib/batch-trade";
import { MAX_BUY_KEEP_SOL_LAMPORTS } from "../lib/params";

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
