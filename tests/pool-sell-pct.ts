// Offline regression test for the manual SELL on the MIGRATED venue (the
// counterpart of tests/pool-buy-budget.ts).
//
// A graduated mint has no tradable curve (every curve sell reverts), so the
// trade panel's Sell routes to the canonical PumpSwap pool through Sell All's
// per-wallet pool leg. This suite pins the pieces that decide whether that sell
// is safe and correctly sized:
//
//   1. `pctTokens` — the % input is applied to the LIVE balance, floored, and
//      can never exceed it. At 100 it is the whole bag EXACTLY, which is what
//      keeps the sell-all full-balance contract byte-identical.
//   2. the fold is sized for the amounts actually sold (a 50% sell must not be
//      handed a 100% floor) and its floors fall along the sequence.
//   3. the guard rails (slippage ceiling, sell % range) fire BEFORE any network
//      call, and past them the leg reports an HONEST per-wallet outcome instead
//      of throwing.
//   4. the batch pre-flights a pool-less mint with ONE clean error.
//
// No network, no keys.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pool-sell-pct.ts"

import { expect } from "chai";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import { sellSelectedWalletsMigrated } from "../lib/batch-trade";
import { MAX_SLIPPAGE_PCT, pctTokens, sellOneWalletOnPool } from "../lib/sell-all";
import { foldPoolSells } from "../lib/sell-fold";

/** The real graduated mint + its canonical PumpSwap pool (used for the
 *  pre-flight assertions; the pool read is stubbed, no RPC is made). */
const MINT = new PublicKey("5LPRbTRqc37wWt6kGeyLgitnxrTFQBLfyK4D8aVMpump");
const POOL = new PublicKey("2s6B6mKgiCwB5qBofuxTFkmRS68pgRAeFe5MSca47tuP");

/** Live pool reserves read from that pool (scripts/check-pool-buy-plan.ts
 *  printed them): real base/quote reserves plus the pool's virtual quote
 *  reserve. Fixtures for the fold, not constants of the code. */
const POOL_RESERVES = {
  baseReserve: BigInt("976873045213557"),
  quoteReserve: BigInt("1231173539"),
  virtualQuoteReserves: BigInt("17584505288"),
  /** Highest fee tier total (93 + 2 + 30 bps), the fold's conservative default. */
  feeBpsTotal: BigInt(125),
  slippageBps: BigInt(500),
};

const ONE_RAW = BigInt(1_000_000); // 1 token at 6 decimals

describe("pctTokens (partial-sell sizing)", () => {
  it("100% takes the whole balance EXACTLY (the sell-all contract)", () => {
    const balance = BigInt("123456789");
    expect(pctTokens(balance, 100)).to.equal(balance);
    // Above 100 is still the whole bag, never more than the wallet holds.
    expect(pctTokens(balance, 250)).to.equal(balance);
  });

  it("a partial sell floors and never exceeds the balance", () => {
    expect(pctTokens(BigInt(1000), 50)).to.equal(BigInt(500));
    expect(pctTokens(BigInt(999), 50)).to.equal(BigInt(499)); // floored
    expect(pctTokens(BigInt(1000), 1)).to.equal(BigInt(10));
    expect(pctTokens(BigInt(1000), 12.5)).to.equal(BigInt(125));
  });

  it("a percentage that floors to zero raw units yields nothing (SKIPPED, not a zero sell)", () => {
    // 1% of 9 raw units is 0.09 -> 0. The legs report that wallet as skipped.
    expect(pctTokens(BigInt(9), 1)).to.equal(BigInt(0));
    expect(pctTokens(BigInt(0), 100)).to.equal(BigInt(0));
  });

  it("0 / negative / non-finite yields nothing", () => {
    for (const pct of [0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(pctTokens(BigInt(1000), pct)).to.equal(BigInt(0));
    }
  });
});

describe("foldPoolSells is sized for the amounts actually sold", () => {
  const full = ONE_RAW * BigInt(1_000_000); // 1,000,000 tokens

  it("a 50% sell gets a roughly half floor, never the full-bag floor", () => {
    const fullSteps = foldPoolSells({
      balances: [{ address: "a", tokens: full }],
      ...POOL_RESERVES,
    });
    const halfSteps = foldPoolSells({
      balances: [{ address: "a", tokens: full / BigInt(2) }],
      ...POOL_RESERVES,
    });
    expect(halfSteps[0].minSolOut < fullSteps[0].minSolOut).to.equal(true);
    // Constant product: the ratio is slightly above a half, never below it.
    const ratio = Number(halfSteps[0].minSolOut) / Number(fullSteps[0].minSolOut);
    expect(ratio).to.be.greaterThan(0.45);
    expect(ratio).to.be.lessThan(0.55);
    expect(halfSteps[0].tokensIn).to.equal(full / BigInt(2));
  });

  it("floors fall along the sequence (the fold's whole purpose)", () => {
    const steps = foldPoolSells({
      balances: [
        { address: "a", tokens: full },
        { address: "b", tokens: full },
        { address: "c", tokens: full },
      ],
      ...POOL_RESERVES,
    });
    expect(steps.length).to.equal(3);
    expect(steps[1].minSolOut < steps[0].minSolOut).to.equal(true);
    expect(steps[2].minSolOut < steps[1].minSolOut).to.equal(true);
  });

  it("zero-amount wallets drop out of the plan instead of taking a step", () => {
    const steps = foldPoolSells({
      balances: [
        { address: "a", tokens: full },
        { address: "b", tokens: BigInt(0) },
      ],
      ...POOL_RESERVES,
    });
    expect(steps.length).to.equal(1);
    expect(steps[0].address).to.equal("a");
  });
});

describe("sellOneWalletOnPool guard rails (before any network call)", () => {
  const wallet = Keypair.generate();
  const base = { connection: {} as unknown as Connection, mint: MINT, poolKey: POOL, wallet };

  it("refuses a slippage above MAX_SLIPPAGE_PCT", async () => {
    let thrown: unknown = null;
    try {
      await sellOneWalletOnPool({
        ...base,
        sellPct: 100,
        slippagePct: MAX_SLIPPAGE_PCT + 1,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown, "expected the promise to reject").to.not.equal(null);
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).to.match(/outside the allowed range/);
    expect(msg).to.match(/MAX_SLIPPAGE_PCT/);
  });

  it("refuses a sellPct outside (0, 100]", async () => {
    for (const pct of [0, -1, 101]) {
      let thrown: unknown = null;
      try {
        await sellOneWalletOnPool({ ...base, sellPct: pct, slippagePct: 5 });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `expected sellPct ${pct} to reject`).to.not.equal(null);
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      expect(msg).to.match(/sellPct .* outside the allowed range \(0, 100\]/);
    }
  });

  it("an unreadable balance is a zero balance: SKIPPED, nothing is sent", async () => {
    // walletTokenBalance swallows a read failure and returns 0 (repo-wide
    // behaviour: an unreadable balance must never authorise a sell), so this
    // leg reports the wallet as skipped rather than pretending it has a bag.
    const outcome = await sellOneWalletOnPool({
      ...base,
      sellPct: 50,
      slippagePct: MAX_SLIPPAGE_PCT,
    });
    expect(outcome.status).to.equal("skipped");
    expect(outcome.route).to.equal("pumpSwap");
    expect(outcome.reason).to.match(/zero token balance/);
  });

  it("with a readable balance it reports a FAILED outcome, never a thrown error", async () => {
    // The stub holds a bag and a 1 SOL balance, then fails at the pool read:
    // the leg's own retry policy must classify that as permanent and hand back
    // an outcome, so the manual round reports FAILED n instead of losing the
    // whole round to an exception.
    const stub = {
      getTokenAccountBalance: async () => ({ value: { amount: "1000000" } }),
      getBalance: async () => 1_000_000_000,
      getAccountInfo: async () => ({}),
    } as unknown as Connection;
    const outcome = await sellOneWalletOnPool({
      connection: stub,
      mint: MINT,
      poolKey: POOL,
      wallet: Keypair.generate(),
      sellPct: 50,
      slippagePct: 5,
    });
    expect(outcome.status).to.equal("failed");
    expect(outcome.route).to.equal("pumpSwap");
    expect(outcome.tokenSold).to.equal(BigInt(0));
    expect(outcome.attempts).to.equal(1);
    // The reason is the real failure, not one of the guard messages.
    expect(outcome.reason ?? "").to.not.match(/outside the allowed range/);
  });
});

describe("sellSelectedWalletsMigrated pre-flight", () => {
  const junkWallet = { address: MINT.toBase58(), key: "not-base58" };

  it("returns zeros for zero wallets without touching the Connection", async () => {
    const result = await sellSelectedWalletsMigrated({
      connection: {} as never,
      mint: MINT,
      poolKey: POOL,
      wallets: [],
      sellPct: 100,
    });
    expect(result).to.deep.equal({
      completed: 0,
      failed: 0,
      skipped: 0,
      signatures: [],
    });
  });

  it("validates the sell % and the slippage BEFORE the pool read", async () => {
    for (const opts of [
      { sellPct: 0 },
      { sellPct: 101 },
      { sellPct: 100, slippagePct: MAX_SLIPPAGE_PCT + 1 },
    ]) {
      let thrown: unknown = null;
      try {
        await sellSelectedWalletsMigrated({
          connection: {} as never,
          mint: MINT,
          poolKey: POOL,
          wallets: [junkWallet],
          ...opts,
        });
      } catch (e) {
        thrown = e;
      }
      expect(thrown, `expected ${JSON.stringify(opts)} to reject`).to.not.equal(null);
      const msg = thrown instanceof Error ? thrown.message : String(thrown);
      expect(msg).to.match(/outside the allowed range/);
      // A junk key would blow up on decode if the validation had not run first.
      expect(msg).to.not.match(/base58/i);
    }
  });

  it("fails the whole run with a clean error when the pool account is missing", async () => {
    const stub = { getAccountInfo: async () => null } as unknown as Connection;
    let thrown: unknown = null;
    try {
      await sellSelectedWalletsMigrated({
        connection: stub,
        mint: MINT,
        poolKey: POOL,
        wallets: [junkWallet],
        sellPct: 50,
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
