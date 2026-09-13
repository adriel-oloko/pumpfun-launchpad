// Offline regression test for docs/SELL_ALL_CONCURRENCY_FIX.md (R1-R4).
//
// Pins the retry policy that fixes the devnet sell-all slippage race:
//   - R1: a slippage revert is retryable-with-fresh-quote, and MUST be
//     classified BEFORE isOnChainRevert (which matches the same message via
//     "custom program error" / "instructionerror" and would mark it permanent).
//   - R3: an absurd slippage is refused before any network call.
//
// No network, no keys. The revert strings are the real captured forms from the
// spec (section 2.1 and 3.2) — do not re-derive them.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/sell-all-retry-policy.ts"

import { expect } from "chai";
import { Connection, PublicKey } from "@solana/web3.js";
import { isOnChainRevert, isSlippageRevert } from "../lib/tx-errors";
import {
  MAX_SLIPPAGE_PCT,
  classifySellError,
  sellAllManagedWallets,
} from "../lib/sell-all";

/** The exact pool-leg revert captured from a live devnet sell-all tx
 *  (spec section 2.1). */
const POOL_REVERT_EXACT =
  "AnchorError thrown in programs/pump-amm/src/instructions/swap/sell.rs:170. " +
  "Error Code: ExceededSlippage. Error Number: 6004. Error Message: ExceededSlippage.";

/** The instruction-error form our own sender throws from `confirmed.value.err`. */
const POOL_REVERT_CUSTOM =
  'transaction failed on chain: {"InstructionError":[1,{"Custom":6004}]}';

/** The curve-leg revert (pump program). The name is authoritative; the numeric
 *  code is inferred, so this suite matches on the name. */
const CURVE_REVERT =
  "Program log: Error Code: TooLittleSolReceived. Error Message: " +
  "slippage: Too little SOL received to sell the given amount of tokens.";

const POOL_NOT_FOUND =
  "PumpSwap pool Fm4v6CeVSNJrJ7Tx4ktd7wFCdC3WXxhkCbZQRTYxzvzM not found (not migrated?)";

const BLOCKHASH_EXPIRED =
  "TransactionExpiredBlockheightExceededError: blockhash not found";

const RATE_LIMIT = "HTTP 429 Too Many Requests: rate limit exceeded";

describe("isSlippageRevert (R1)", () => {
  it("assertion 1: true for the exact captured pump-amm ExceededSlippage string", () => {
    expect(isSlippageRevert(POOL_REVERT_EXACT)).to.equal(true);
  });

  it("assertion 2: true for the Custom: 6004 instruction-error form and the curve TooLittleSolReceived form", () => {
    expect(isSlippageRevert(POOL_REVERT_CUSTOM)).to.equal(true);
    expect(isSlippageRevert(CURVE_REVERT)).to.equal(true);
    // The generic anchor "slippage" wording is also covered.
    expect(isSlippageRevert("Error Message: too little sol received")).to.equal(
      true
    );
  });

  it("assertion 3: FALSE for a missing pool, a blockhash expiry, and an RPC 429", () => {
    expect(isSlippageRevert(POOL_NOT_FOUND)).to.equal(false);
    expect(isSlippageRevert(BLOCKHASH_EXPIRED)).to.equal(false);
    expect(isSlippageRevert(RATE_LIMIT)).to.equal(false);
  });
});

describe("classifySellError ordering (R1, assertion 5)", () => {
  it("routes an ExceededSlippage revert to the slippage retry, never the permanent on-chain path", () => {
    // The collision that causes the bug: our own sender throws the
    // InstructionError form, which isOnChainRevert also matches...
    expect(isOnChainRevert(POOL_REVERT_CUSTOM)).to.equal(true);
    // ...but the classifier checks isSlippageRevert FIRST, so the chosen path
    // is the slippage re-quote, not a permanent break. (The raw AnchorError
    // line is matched by isSlippageRevert on its own name/code.)
    expect(isSlippageRevert(POOL_REVERT_EXACT)).to.equal(true);
    expect(classifySellError(POOL_REVERT_EXACT)).to.equal("slippage");
    expect(classifySellError(POOL_REVERT_CUSTOM)).to.equal("slippage");
    expect(classifySellError(CURVE_REVERT)).to.equal("slippage");
  });

  it("keeps the other classes distinct", () => {
    expect(classifySellError(RATE_LIMIT)).to.equal("transient");
    expect(classifySellError(BLOCKHASH_EXPIRED)).to.equal("transient");
    expect(classifySellError(POOL_NOT_FOUND)).to.equal("permanent");
    expect(classifySellError("insufficient funds")).to.equal("permanent");
  });
});

describe("slippage guard (R3, assertion 4)", () => {
  it("MAX_SLIPPAGE_PCT is 25", () => {
    expect(MAX_SLIPPAGE_PCT).to.equal(25);
  });

  it("rejects slippagePct above the ceiling before any network call", async () => {
    // A stub connection would throw TypeError on any method access; the guard
    // must fire first, proving no RPC was attempted. `as never` avoids a fake
    // Connection implementation.
    let thrown: unknown = null;
    try {
      await sellAllManagedWallets({
        connection: {} as never,
        mint: new PublicKey("Cu5oKWBjYoFzg1Wcd38zZRHqbaFwgFaAFnKobo4eA38G"),
        wallets: [],
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

  it("accepts the ceiling itself past the guard (fails later, not on the guard)", async () => {
    // With a valid slippage the guard passes; the stub connection then fails,
    // which proves the guard did not over-reject. The thrown message must NOT
    // be the guard message.
    let thrown: unknown = null;
    try {
      await sellAllManagedWallets({
        connection: {} as never,
        mint: new PublicKey("Cu5oKWBjYoFzg1Wcd38zZRHqbaFwgFaAFnKobo4eA38G"),
        wallets: [],
        slippagePct: MAX_SLIPPAGE_PCT,
      });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).to.not.equal(null);
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).to.not.match(/outside the allowed range/);
  });
});

describe("sellAllManagedWallets validates before touching the Connection", () => {
  it("the guard runs before readPumpCurveState (still true with a real Connection type)", async () => {
    // Type-only use keeps the import honest: this is exactly the shape the
    // function receives.
    const connection = {} as unknown as Connection;
    let thrown: unknown = null;
    try {
      await sellAllManagedWallets({
        connection,
        mint: new PublicKey("Cu5oKWBjYoFzg1Wcd38zZRHqbaFwgFaAFnKobo4eA38G"),
        wallets: [],
        slippagePct: 100,
      });
    } catch (e) {
      thrown = e;
    }
    const msg = thrown instanceof Error ? thrown.message : String(thrown);
    expect(msg).to.match(/outside the allowed range/);
  });
});
