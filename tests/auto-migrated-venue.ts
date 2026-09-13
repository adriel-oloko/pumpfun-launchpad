// Offline regression test for the AUTO bot on the MIGRATED venue.
//
// A graduated mint (curve `complete` = 1) has no tradable curve: every curve
// buy/sell reverts on-chain, so the scheduler routes the round to the canonical
// PumpSwap pool. This suite pins the AUTO-level seams that decide the route and
// whether the pool buy can land:
//
//   1. `autoVenueFor` picks the curve before graduation and the canonical pool
//      PDA after it (the same derivation every other surface uses).
//   2. `poolSpendableForBuy` keeps the curve worker's rule (rent floor + tx fee
//      reserve) and reserves ONLY the accounts the buy tx actually creates.
//   3. `poolBuyCommitLamports` applies min(buyPct%, spendable / 1.10), so the
//      default 95% is always capped by the slippage band.
//   4. THE INVARIANT: the SDK wraps `commit * (1 + 10%)` as WSOL, and that wrap
//      must never exceed the spendable base. At 95% the headroom is exactly 1
//      lamport (integer flooring on both sides) — this is what makes the pool
//      buy landable on a wallet sized down to its keep.
//   5. `pctTokens` is the auto-sell's %-of-live-balance seam (100% == the whole
//      bag exactly; a % that floors to zero raw units is a skip, not a zero
//      sell).
//   6. guard rails fire before any network call.
//
// No network, no keys.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/auto-migrated-venue.ts"

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  AUTO_SELL_PCT,
  AUTO_TX_FEE_RESERVE_LAMPORTS,
  autoVenueFor,
  fireAutoBuyPool,
  fireAutoSellPool,
  poolBuyCommitLamports,
  poolBuyWrapLamports,
  poolSpendableForBuy,
  type AutoCurveInfo,
} from "../lib/auto";
import { RENT_EXEMPT_FLOOR } from "../lib/bundle/launch";
import { canonicalMigratedPoolPda } from "../lib/migrate";
import { pctTokens } from "../lib/sell-all";

/** The real graduated mint + its canonical PumpSwap pool (frozen pair, spec
 *  section 4.1). */
const MINT = new PublicKey("5LPRbTRqc37wWt6kGeyLgitnxrTFQBLfyK4D8aVMpump");
const POOL = new PublicKey("2s6B6mKgiCwB5qBofuxTFkmRS68pgRAeFe5MSca47tuP");

/** Rent fixtures (a live read, not a code constant): 170-byte Token-2022 ATA /
 *  165-byte WSOL ATA. */
const BASE_ATA_RENT = BigInt(1_513_840);
const WSOL_ATA_RENT = BigInt(1_488_440);

function curveInfo(graduated: boolean): AutoCurveInfo {
  return {
    creator: PublicKey.default.toBase58(),
    graduated,
    solReserve: BigInt(0),
    tokenReserve: BigInt(0),
  };
}

describe("autoVenueFor (curve vs canonical PumpSwap pool)", () => {
  it("routes a live curve to the curve", () => {
    expect(autoVenueFor(MINT, curveInfo(false))).to.deep.equal({
      kind: "curve",
    });
  });

  it("routes a graduated curve to the canonical pool PDA", () => {
    const venue = autoVenueFor(MINT, curveInfo(true));
    expect(venue.kind).to.equal("pumpSwap");
    expect(venue.kind === "pumpSwap" && venue.poolKey.toBase58()).to.equal(
      POOL.toBase58()
    );
    // The venue pool IS the canonical derivation (no second source of truth).
    expect(canonicalMigratedPoolPda(MINT)[0].toBase58()).to.equal(
      POOL.toBase58()
    );
  });
});

describe("poolSpendableForBuy (the pool buy's spendable base)", () => {
  const live = BigInt(100_000_000); // 0.1 SOL

  it("keeps the rent floor + tx fee reserve when both ATAs exist", () => {
    expect(
      poolSpendableForBuy({
        liveLamports: live,
        baseAtaRentLamports: BigInt(0),
        wsolAtaRentLamports: BigInt(0),
      })
    ).to.equal(live - BigInt(RENT_EXEMPT_FLOOR) - AUTO_TX_FEE_RESERVE_LAMPORTS);
  });

  it("reserves each missing ATA's rent exactly once", () => {
    const both = poolSpendableForBuy({
      liveLamports: live,
      baseAtaRentLamports: BASE_ATA_RENT,
      wsolAtaRentLamports: WSOL_ATA_RENT,
    });
    const baseOnly = poolSpendableForBuy({
      liveLamports: live,
      baseAtaRentLamports: BigInt(0),
      wsolAtaRentLamports: WSOL_ATA_RENT,
    });
    const wsolOnly = poolSpendableForBuy({
      liveLamports: live,
      baseAtaRentLamports: BASE_ATA_RENT,
      wsolAtaRentLamports: BigInt(0),
    });
    expect(baseOnly - both).to.equal(BASE_ATA_RENT);
    expect(wsolOnly - both).to.equal(WSOL_ATA_RENT);
  });

  it("never returns negative: a dust balance yields 0 (skip, never overdraw)", () => {
    expect(
      poolSpendableForBuy({
        liveLamports:
          BigInt(RENT_EXEMPT_FLOOR) + AUTO_TX_FEE_RESERVE_LAMPORTS - BigInt(1),
        baseAtaRentLamports: BigInt(0),
        wsolAtaRentLamports: BigInt(0),
      })
    ).to.equal(BigInt(0));
    expect(
      poolSpendableForBuy({
        liveLamports: BigInt(0),
        baseAtaRentLamports: BASE_ATA_RENT,
        wsolAtaRentLamports: WSOL_ATA_RENT,
      })
    ).to.equal(BigInt(0));
  });
});

describe("poolBuyCommitLamports (min(buyPct%, spendable / 1.10))", () => {
  it("at the default 95% the slippage cap binds", () => {
    const spendable = BigInt(50_000_000);
    const cap = (spendable * BigInt(10_000)) / BigInt(11_000);
    expect(poolBuyCommitLamports(spendable)).to.equal(cap);
  });

  it("at a low pct the percentage binds instead", () => {
    const spendable = BigInt(50_000_000);
    const commit = poolBuyCommitLamports(spendable, 50);
    expect(commit).to.equal(spendable / BigInt(2));
    expect(commit < poolBuyCommitLamports(spendable)).to.equal(true);
  });

  it("returns 0 for a zero/negative spendable", () => {
    expect(poolBuyCommitLamports(BigInt(0))).to.equal(BigInt(0));
    expect(poolBuyCommitLamports(BigInt(-5))).to.equal(BigInt(0));
  });
});

describe("poolBuyWrapLamports (the invariant the pool buy depends on)", () => {
  it("the wrap never exceeds spendable and headroom is exactly 1 lamport at 95%", () => {
    const spendables = [
      BigInt(5_000_000), // 0.005 SOL
      BigInt(10_000_000), // 0.01 SOL
      BigInt(50_000_000), // 0.05 SOL
      BigInt(100_000_000), // 0.10 SOL
      BigInt(1_000_000_000), // 1 SOL
    ];
    for (const spendable of spendables) {
      const commit = poolBuyCommitLamports(spendable);
      const wrap = poolBuyWrapLamports(commit, 10);
      expect(wrap <= spendable, `wrap ${wrap} > spendable ${spendable}`).to.equal(
        true
      );
      expect(spendable - wrap, `headroom at ${spendable}`).to.equal(BigInt(1));
    }
  });

  it("a low pct leaves the full slippage band unbought (wrap stays under spendable)", () => {
    const spendable = BigInt(100_000_000);
    const commit = poolBuyCommitLamports(spendable, 50);
    const wrap = poolBuyWrapLamports(commit, 10);
    expect(wrap).to.equal((spendable / BigInt(2)) * BigInt(11) / BigInt(10));
    expect(wrap < spendable).to.equal(true);
  });
});

describe("pctTokens (the auto-sell's live-balance % seam)", () => {
  it("100% (the AUTO_SELL_PCT default) is the exact balance", () => {
    const balance = BigInt("123456789");
    expect(AUTO_SELL_PCT).to.equal(100);
    expect(pctTokens(balance, AUTO_SELL_PCT)).to.equal(balance);
  });

  it("a percentage that floors to zero raw units yields nothing (a skip)", () => {
    expect(pctTokens(BigInt(9), 1)).to.equal(BigInt(0));
  });
});

describe("pool worker guard rails (before any network call)", () => {
  it("fireAutoBuyPool returns zeros for zero wallets without a Connection call", async () => {
    const result = await fireAutoBuyPool({
      connection: {} as never,
      mint: MINT,
      poolKey: POOL,
      wallets: [],
      minSolLamports: BigInt(0),
    });
    expect(result).to.deep.equal({ completed: 0, failed: 0, skipped: 0 });
  });

  it("fireAutoSellPool returns zeros for zero wallets without a Connection call", async () => {
    const result = await fireAutoSellPool({
      connection: {} as never,
      mint: MINT,
      poolKey: POOL,
      wallets: [],
      sellPct: 50,
    });
    expect(result).to.deep.equal({
      completed: 0,
      failed: 0,
      skipped: 0,
      swept: 0,
      sweepFailed: 0,
    });
  });

  it("fireAutoSellPool refuses a sellPct outside (0, 100] before the pool read", async () => {
    let thrown: unknown = null;
    try {
      await fireAutoSellPool({
        connection: {} as never,
        mint: MINT,
        poolKey: POOL,
        wallets: [{ address: MINT.toBase58(), key: "not-base58" }],
        sellPct: 0,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "expected the promise to reject").to.not.equal(null);
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).to.match(/sellPct .* outside the allowed range \(0, 100\]/);
  });
});
