// Offline regression test for the CURVE MAX buy: the exact-in shape and the
// slippage band that now rides on it.
//
// Until 2026-09-14 the curve MAX buy was the token-exact-out
// `buy(tokens_out, max_sol_cost)` quoted at a ZERO band (lib/batch-trade.ts
// `buyOne`, lib/auto.ts's curve worker), because a band on that shape can only
// be funded by committing `budget / (1 + s)` and stranding the difference.
// The curve program's own `buy_exact_sol_in(spendable_sol_in, min_tokens_out,
// track_volume)` removes that trade-off: the whole budget is spent and the
// band is a FLOOR on the tokens received. This suite pins:
//
//   1. the quote math (delegates to quotePumpBuy, so the two shapes agree) and
//      the floor arithmetic.
//   2. the instruction: discriminator, both args, track_volume byte, and the
//      account list being IDENTICAL to the proven `buy` list (the program
//      declares the same 16 accounts in the same order for both).
//
// No network, no keys.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/curve-buy-exact-in.ts"

import { expect } from "chai";
import { Buffer } from "buffer";
import { PublicKey } from "@solana/web3.js";
import { CURVE_SLIPPAGE_BPS } from "../lib/params";
import {
  PUMP_BUY_DISCRIMINATOR,
  PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR,
  buildPumpBuyExactSolInIx,
  buildPumpBuyIx,
  quotePumpBuy,
  quotePumpBuyExactIn,
} from "../lib/pump";

/** A curve state (virtual reserves: 30 SOL in, 1.073B tokens out; the live
 *  seeded shapes, as fixtures). */
const VSR = BigInt(30_000_000_000);
const VTR = BigInt(1_073_000_000_000_000);
const SOL_IN = BigInt(100_000_000); // 0.1 SOL
const MULT = BigInt(10_000);

const MINT = new PublicKey("5LPRbTRqc37wWt6kGeyLgitnxrTFQBLfyK4D8aVMpump");
const BUYER = new PublicKey("9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM");
const CREATOR = new PublicKey("3S8qX1MsMqRbiwKg2cQyx7nis1oHMgaCuc9c4VfvVdPN");
const FEE_RECIPIENT = new PublicKey("CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM");

describe("quotePumpBuyExactIn (curve exact-in: full spend, band as a floor)", () => {
  it("agrees with quotePumpBuy on the tokens, and floors them by the band", () => {
    const q = quotePumpBuyExactIn({
      solInLamports: SOL_IN,
      virtualSolReserves: VSR,
      virtualTokenReserves: VTR,
      slippageBps: CURVE_SLIPPAGE_BPS,
    });
    const plain = quotePumpBuy({
      solInLamports: SOL_IN,
      virtualSolReserves: VSR,
      virtualTokenReserves: VTR,
      slippageBps: CURVE_SLIPPAGE_BPS,
    });
    expect(q.tokensOut).to.equal(plain.tokensOut);
    expect(q.nextVirtualSolReserves).to.equal(plain.nextVirtualSolReserves);
    expect(q.nextVirtualTokenReserves).to.equal(plain.nextVirtualTokenReserves);
    // 20% off the expected tokens.
    expect(q.minTokensOut).to.equal(
      (q.tokensOut * (MULT - CURVE_SLIPPAGE_BPS)) / MULT
    );
    expect(q.minTokensOut < q.tokensOut).to.equal(true);
    expect(CURVE_SLIPPAGE_BPS).to.equal(BigInt(2000));
  });

  it("0 bps pins the floor to the expected tokens; 10000 pins it to zero", () => {
    const base = {
      solInLamports: SOL_IN,
      virtualSolReserves: VSR,
      virtualTokenReserves: VTR,
    };
    const atZero = quotePumpBuyExactIn({ ...base, slippageBps: BigInt(0) });
    expect(atZero.minTokensOut).to.equal(atZero.tokensOut);
    const atMax = quotePumpBuyExactIn({ ...base, slippageBps: BigInt(10_000) });
    expect(atMax.minTokensOut).to.equal(BigInt(0));
  });

  it("refuses a band outside [0, 10000] instead of clamping it", () => {
    const base = {
      solInLamports: SOL_IN,
      virtualSolReserves: VSR,
      virtualTokenReserves: VTR,
    };
    expect(() =>
      quotePumpBuyExactIn({ ...base, slippageBps: BigInt(10_001) })
    ).to.throw(/outside the allowed range/);
    expect(() =>
      quotePumpBuyExactIn({ ...base, slippageBps: BigInt(-1) })
    ).to.throw(/outside the allowed range/);
  });

  it("refuses a non-positive input", () => {
    expect(() =>
      quotePumpBuyExactIn({
        solInLamports: BigInt(0),
        virtualSolReserves: VSR,
        virtualTokenReserves: VTR,
      })
    ).to.throw(/must be positive/);
  });
});

describe("buildPumpBuyExactSolInIx (the curve exact-in instruction)", () => {
  const ixs = buildPumpBuyExactSolInIx({
    mint: MINT,
    buyer: BUYER,
    creator: CREATOR,
    feeRecipient: FEE_RECIPIENT,
    spendableSolIn: SOL_IN,
    minTokensOut: BigInt(800),
  });
  const buy = ixs[1];
  const data = Buffer.from(buy.data);

  it("is the ATA-create + buy_exact_sol_in pair", () => {
    expect(ixs.length).to.equal(2);
    // The ATA-create leg comes first and targets the buyer's Token-2022 ATA.
    expect(ixs[0].keys[0].pubkey.toBase58()).to.equal(BUYER.toBase58());
  });

  it("carries the buy_exact_sol_in discriminator, not the plain buy's", () => {
    expect(data.length).to.equal(25);
    expect(Array.from(data.subarray(0, 8))).to.deep.equal(
      PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR
    );
    expect(Array.from(data.subarray(0, 8))).to.not.deep.equal(
      PUMP_BUY_DISCRIMINATOR
    );
  });

  it("encodes spendable_sol_in, min_tokens_out and track_volume", () => {
    expect(data.readBigUInt64LE(8)).to.equal(SOL_IN);
    expect(data.readBigUInt64LE(16)).to.equal(BigInt(800));
    expect(data[24]).to.equal(1);
  });

  it("uses the SAME account list as the proven buy instruction", () => {
    const plain = buildPumpBuyIx({
      mint: MINT,
      buyer: BUYER,
      creator: CREATOR,
      feeRecipient: FEE_RECIPIENT,
      tokensOut: BigInt(1),
      maxSolCost: BigInt(1),
    })[1];
    expect(buy.programId.toBase58()).to.equal(plain.programId.toBase58());
    expect(buy.keys.length).to.equal(plain.keys.length);
    plain.keys.forEach((k, i) => {
      expect(buy.keys[i].pubkey.toBase58(), `key ${i}`).to.equal(
        k.pubkey.toBase58()
      );
      expect(buy.keys[i].isSigner, `signer ${i}`).to.equal(k.isSigner);
      expect(buy.keys[i].isWritable, `writable ${i}`).to.equal(k.isWritable);
    });
  });

  it("refuses a non-positive spendable input", () => {
    expect(() =>
      buildPumpBuyExactSolInIx({
        mint: MINT,
        buyer: BUYER,
        creator: CREATOR,
        feeRecipient: FEE_RECIPIENT,
        spendableSolIn: BigInt(0),
        minTokensOut: BigInt(0),
      })
    ).to.throw(/must be positive/);
  });
});
