// Sell-all stage 2 (see PLAN-SELLALL-STAGE2.md): FOLDED FLOORS.
//
// Today every wallet in a sell-all is quoted against ONE run-level snapshot.
// Because each sell is a large fraction of the pool, the earlier sellers move
// the price before the later transactions land, and the later floors reject the
// fill (`Custom 6004` / ExceededSlippage on the pool leg, TooLittleSolReceived on
// the curve leg). Measured on devnet 2026-09-13: the two SEQUENTIAL sells landed
// first try; two of the three CONCURRENT ones reverted and were rescued by the
// retry.
//
// The fold derives each wallet's floor from the reserves its PREDECESSORS' sells
// leave, in sell order. Two invariants make this safe rather than clever:
//
//  1. The slippage band (5 percent) is applied ON TOP of the folded expectation,
//     so the band keeps protecting against EXTERNAL adverse fills while our own
//     sequence can no longer trip it. The candidate fee models differ by about
//     1.25 percent of the proceeds, well inside that band, which is why the fold
//     does not need bit-exact fee modelling to be safe.
//  2. Every fold step advances the reserves CONSERVATIVELY (never more
//     favourable than the program's own accounting), so a folded floor can only
//     be LOOSER than the price that will actually print. The callers then take
//     min(foldedFloor, freshQuoteFloor), so a folded floor can never be tighter
//     than the quote they would have used anyway.
//
// PURE: integer math only, no RPC, no Connection, so the offline suite pins it.

import { quotePumpSell } from "./pump";

/** One wallet's place in the folded sell sequence. */
export interface SellSequenceStep {
  /** Roster address (the fold never sees a keypair). */
  address: string;
  /** Full base balance this wallet sells, raw token units. */
  tokensIn: bigint;
  /** Expected NET SOL out at this step, before the slippage band, lamports. */
  expectedSolOut: bigint;
  /** The floor handed to the sell instruction: expected minus the band. */
  minSolOut: bigint;
}

/** Runtime guard shared by both folds: a floor is a floor, never a price. */
function banded(net: bigint, slippageBps: bigint): bigint {
  return (net * (BigInt(10_000) - slippageBps)) / BigInt(10_000);
}

/**
 * Curve-leg fold (the NOT-graduated route).
 *
 * Each step is quoted with `quotePumpSell`, the same function the curve sell
 * instruction is quoted with, so the folded expectation and the instruction's
 * own quote cannot drift apart. The advance is deliberately the program's own
 * shape with the FAVOURABLE half removed:
 *
 *   token reserve += tokensIn          (the full input, not the post-fee part)
 *   sol reserve   -= grossSolOut       (the pre-fee output)
 *
 * Both choices make the next step's price lower than reality, so successors get
 * a looser floor, never a tighter one.
 */
export function foldCurveSells(opts: {
  balances: { address: string; tokens: bigint }[];
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  /** Protocol + creator fee, basis points. Defaults to the instruction's own. */
  feeBps?: bigint;
  /** Slippage band, basis points. */
  slippageBps?: bigint;
}): SellSequenceStep[] {
  const slippageBps = opts.slippageBps ?? BigInt(500);
  let vSol = opts.virtualSolReserves;
  let vTok = opts.virtualTokenReserves;
  const steps: SellSequenceStep[] = [];
  for (const b of opts.balances) {
    if (b.tokens <= BigInt(0)) continue;
    const q = quotePumpSell({
      tokensIn: b.tokens,
      virtualSolReserves: vSol,
      virtualTokenReserves: vTok,
      feeBps: opts.feeBps,
      slippageBps,
    });
    steps.push({
      address: b.address,
      tokensIn: b.tokens,
      expectedSolOut: q.netSolOut,
      minSolOut: q.minSolOutput,
    });
    vTok = vTok + b.tokens;
    vSol = vSol - q.grossSolOut;
  }
  return steps;
}

/**
 * Pool-leg fold (the graduated PumpSwap route).
 *
 * Mirrors the SDK's own sell quote (`@pump-fun/pump-swap-sdk`,
 * `dist/index.js:9773` `sellBaseInput`): the constant product runs against the
 * EFFECTIVE quote reserve (real + virtual), the fees come off the gross output,
 * and the seller receives the net of all three fees. Two deliberate
 * simplifications, both on the conservative side:
 *
 *  - one total fee (`feeBpsTotal`, the highest tier total: 93 + 2 + 30) instead
 *    of the per-step tier, so the net can only come out lower;
 *  - the real quote reserve drops by the whole net, ignoring the small LP
 *    retention that actually stays in the vault, so successors quote against
 *    less liquidity than they will really see.
 *
 * `feeBpsTotal` is passed in rather than imported so the caller stays the single
 * place that knows which tier the run is in.
 */
export function foldPoolSells(opts: {
  balances: { address: string; tokens: bigint }[];
  /** Real base reserve at the head of the sequence (raw token units). */
  baseReserve: bigint;
  /** Real quote reserve at the head of the sequence (lamports). */
  quoteReserve: bigint;
  /** The pool's recorded virtual quote reserve (lamports). */
  virtualQuoteReserves: bigint;
  feeBpsTotal: bigint;
  slippageBps: bigint;
}): SellSequenceStep[] {
  const { balances, feeBpsTotal, slippageBps } = opts;
  const keepBps = BigInt(10_000) - feeBpsTotal;
  let base = opts.baseReserve;
  let quote = opts.quoteReserve;
  const steps: SellSequenceStep[] = [];
  for (const b of balances) {
    if (b.tokens <= BigInt(0)) continue;
    const effectiveQuote = quote + opts.virtualQuoteReserves;
    const denominator = base + b.tokens;
    if (denominator <= BigInt(0)) break;
    const gross = (effectiveQuote * b.tokens) / denominator;
    const net = (gross * keepBps) / BigInt(10_000);
    steps.push({
      address: b.address,
      tokensIn: b.tokens,
      expectedSolOut: net,
      minSolOut: banded(net, slippageBps),
    });
    base = base + b.tokens;
    quote = quote - net;
  }
  return steps;
}

/** True when `a` is at or below `b`; the fold's never-tighter invariant, as a
 *  predicate the callers and the tests can both read. */
export function floorIsNotTighter(a: bigint, b: bigint): boolean {
  return a <= b;
}
