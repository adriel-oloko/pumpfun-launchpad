// Post-migration venue: the PumpSwap AMM buy + sell engines (profile C T2).
//
// After a pump.fun curve fills, the graduating buy migrates the token to a
// canonical PumpSwap pool (base = the pump.fun Token-2022 mint, quote =
// wrapped SOL). This module is the single place the migrated-venue swap math
// lives: the official @pump-fun/pump-swap-sdk builds the instruction stream
// (buyQuoteInput / sellBaseInput), and this module owns the account guards
// and the measured token/SOL deltas.
//
// The SDK does the token-program plumbing itself: `swapSolanaState` derives
// baseTokenProgram from the base mint account's owner and quoteTokenProgram
// from the quote mint's owner, and `buyQuoteInput` prepends the base-ATA
// create + sync + close-WSOL instructions. This file therefore takes NO token
// program argument — Token-2022 is the base invariant and is asserted
// elsewhere, never branched on here.
//
// Browser-safe: Keypairs + the passed Connection only; no `node:` imports and
// no anchor `Program` / `Wallet`. Slippage here is the SDK's PERCENT unit
// (0-100), never the basis points lib/pump.ts quotes use.
//
// BUY SHAPE (2026-09-14): the buy goes out as the program's EXACT-IN
// `buy_exact_quote_in(spendable_quote_in, min_base_amount_out)`, not as the
// SDK's default `buy(base_amount_out, max_quote_amount_in)`. The SDK's shape
// sets max_quote_amount_in = quote * (1 + slippage/100) and WRAPS that whole
// ceiling as WSOL before the swap, so a budget that is the wallet's entire
// balance (the MAX rule) cannot carry a band: the wrap needs more lamports
// than the wallet holds, and sizing the commit at budget / (1 + s/100) to
// make it fit leaves the band's share unbought. Exact-in spends the budget
// itself and expresses the band as a FLOOR ON THE TOKENS RECEIVED, so full
// spend and a real band hold at the same time. The instruction stream is
// still the SDK's own (accounts, base-ATA create, WSOL wrap + close); only
// the one AMM instruction's data is rewritten. See toExactQuoteInBuy.

import { BN } from "@coral-xyz/anchor";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PumpAmmSdk,
  buyQuoteInput as quoteBuyQuoteInput,
  sellBaseInput as quoteSellBaseInput,
  type SwapSolanaState,
} from "@pump-fun/pump-swap-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { Buffer } from "buffer";
import { walletTokenBalance } from "./bundle/launch";
import { sendRawWithRetry } from "./migrate";

/** Exact string lib/sell-all.ts classifies as a permanent "pool missing"
 *  condition (it must survive the retry loop verbatim). */
function poolNotFoundError(poolKey: PublicKey): Error {
  return new Error(
    `PumpSwap pool ${poolKey.toBase58()} not found (not migrated?)`
  );
}

export interface MigratedBuyResult {
  /** Confirmed swap signature. */
  signature: string;
  /** Base-token delta the buyer received (raw Token-2022 units). */
  tokensOut: bigint;
  /** Native SOL lamports the buyer spent (balance delta, nets the tx fee). */
  solSpentLamports: bigint;
}

export interface MigratedSellResult {
  /** Confirmed swap signature. */
  signature: string;
  /** Base tokens handed to the sell instruction (raw units). */
  tokensIn: bigint;
  /** Native SOL lamports the seller received (balance delta, nets the tx
   *  fee; the SDK closes the intermediate WSOL account, so the proceeds are
   *  native SOL). */
  solReceivedLamports: bigint;
}

/**
 * The percent-derived min-out floor for a pool sell, from a swap state the
 * caller has ALREADY read (pure math, no RPC). Every explicit-min caller (the
 * stage-2 fold plan) takes `min(folded, this)` so an explicit floor can only
 * ever LOOSEN the trade:
 *
 * measured on a live pool 2026-09-13, the fold's deliberately conservative fee
 * model came out 1 lamport MORE optimistic than the SDK's own quote for the
 * same balance, which made the folded floor 1 lamport TIGHTER than the floor
 * the percent path would have used: enough to revert a sell that would
 * otherwise have landed. Taking the looser of the two makes "an explicit floor
 * is never tighter than the percent floor" true by construction instead of by
 * arithmetic luck.
 */
export function poolPercentFloor(
  state: SwapSolanaState,
  baseAmount: bigint,
  slippagePct: number
): bigint {
  return BigInt(
    quoteSellBaseInput({
      base: new BN(baseAmount.toString()),
      slippage: slippagePct,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.pool.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
    }).minQuote.toString()
  );
}

/** The migrated venue's BUY band, PERCENT (the SDK's 0-100 unit): on a buy it
 *  is a floor on the tokens received (buy_exact_quote_in's
 *  `min_base_amount_out`). 20 < MAX_SLIPPAGE_PCT, so the engine's guard rail
 *  still admits it. */
export const POOL_BUY_SLIPPAGE_PCT: number = 20;

/** The migrated venue's SELL band, PERCENT (the SDK's 0-100 unit): on a sell it
 *  is a floor on the SOL received (sellInstructions' `minQuoteAmountOut`).
 *  Value 100 = a ZERO floor: the operator's explicit choice (2026-09-14), so a
 *  pool sell never reverts on price. The trade-off is on-chain: with no floor
 *  the fill happens at whatever the pool pays at landing time, with no
 *  sandwich/adverse-fill protection. */
export const POOL_SELL_SLIPPAGE_PCT: number = 100;

/** pump_amm `buy` discriminator (IDL:
 *  node_modules/@pump-fun/pump-swap-sdk/src/idl/pump_amm.json). */
const PUMP_AMM_BUY_DISCRIMINATOR = Buffer.from([
  102, 6, 61, 18, 1, 218, 235, 234,
]);

/** pump_amm `buy_exact_quote_in` discriminator (same IDL). */
const PUMP_AMM_BUY_EXACT_QUOTE_IN_DISCRIMINATOR = Buffer.from([
  198, 46, 21, 82, 180, 217, 232, 112,
]);

/** Both buy instructions carry the same args, so their data is the same
 *  size: disc(8) ++ u64 ++ u64 ++ OptionBool(1). The rewrite below depends on
 *  that byte-for-byte parity and ASSERTS it instead of trusting it. */
const PUMP_AMM_BUY_DATA_BYTES = 25;

/**
 * The base tokens a `spendableQuoteIn` buy returns at the pool's CURRENT
 * reserves, from a swap state the caller has ALREADY read (pure math, no
 * RPC): the SDK's own buy quote, so the floor below is derived from the same
 * numbers the program quotes on.
 */
export function poolBuyBaseOut(
  state: SwapSolanaState,
  spendableQuoteIn: bigint
): bigint {
  return BigInt(
    quoteBuyQuoteInput({
      quote: new BN(spendableQuoteIn.toString()),
      slippage: 0,
      baseReserve: state.poolBaseAmount,
      quoteReserve: state.poolQuoteAmount,
      virtualQuoteReserves: state.pool.virtualQuoteReserves,
      globalConfig: state.globalConfig,
      baseMintAccount: state.baseMintAccount,
      baseMint: state.pool.baseMint,
      coinCreator: state.pool.coinCreator,
      creator: state.pool.creator,
      feeConfig: state.feeConfig,
    }).base.toString()
  );
}

/**
 * The base-token FLOOR of a buy under a slippage band (percent, the SDK's
 * unit): `min_base_amount_out` for buy_exact_quote_in. Mirrors the SDK's own
 * factor shape (`floor((1 + s/100) * 1e9) / 1e9`) so a fractional band is
 * allowed, only here it DISCOUNTS the base instead of grossing up the quote.
 * Pure, exported so the offline tests pin it.
 */
export function poolBuyMinBaseOut(
  baseAmountOut: bigint,
  slippagePct: number
): bigint {
  if (!Number.isFinite(slippagePct) || slippagePct < 0 || slippagePct > 100) {
    throw new Error(
      `buy slippagePct ${slippagePct} is outside the allowed range [0, 100]`
    );
  }
  const factor = BigInt(Math.floor((1 - slippagePct / 100) * 1e9));
  return (baseAmountOut * factor) / BigInt(1_000_000_000);
}

/**
 * Rewrites the SDK's own `buy` instruction into the program's exact-in
 * `buy_exact_quote_in`, keeping its account list untouched.
 *
 * Why this is safe: per the pump_amm IDL both instructions declare the SAME
 * 23 accounts in the SAME order and the SAME args (u64, u64, OptionBool), so
 * the metas the SDK built for `buy` are exactly what exact-in needs and only
 * the 8-byte discriminator plus the two u64 slots change meaning:
 *   buy(base_amount_out, max_quote_amount_in) ->
 *   buy_exact_quote_in(spendable_quote_in, min_base_amount_out)
 * The OptionBool byte (track_volume) is carried over verbatim.
 *
 * The caller MUST have built the stream with the WSOL wrap set to
 * `spendableQuoteIn` (the SDK wraps the `maxQuoteIn` it is given), which is
 * what buyMigratedPool does: exact-in spends exactly that balance.
 *
 * Fails LOUD on anything unexpected (a different instruction, a different
 * data size), so a future SDK change can never silently ship a `buy` with
 * exact-in args, or the reverse.
 */
export function toExactQuoteInBuy(
  ix: TransactionInstruction,
  spendableQuoteIn: bigint,
  minBaseAmountOut: bigint
): TransactionInstruction {
  const data = Buffer.from(ix.data);
  if (data.length !== PUMP_AMM_BUY_DATA_BYTES) {
    throw new Error(
      `expected a ${PUMP_AMM_BUY_DATA_BYTES}-byte pump_amm buy instruction, ` +
        `got ${data.length} bytes (program ${ix.programId.toBase58()})`
    );
  }
  if (!data.subarray(0, 8).equals(PUMP_AMM_BUY_DISCRIMINATOR)) {
    throw new Error(
      `not a pump_amm buy instruction: discriminator ${data
        .subarray(0, 8)
        .toString("hex")}`
    );
  }
  const out = Buffer.alloc(PUMP_AMM_BUY_DATA_BYTES);
  PUMP_AMM_BUY_EXACT_QUOTE_IN_DISCRIMINATOR.copy(out, 0);
  out.writeBigUInt64LE(spendableQuoteIn, 8);
  out.writeBigUInt64LE(minBaseAmountOut, 16);
  // track_volume: the SDK passes OptionBool some(true); the byte is identical
  // in both instructions, so carry it over.
  out[24] = data[24];
  return new TransactionInstruction({
    programId: ix.programId,
    keys: ix.keys,
    data: out,
  });
}

/**
 * Builds the exact-in buy STREAM for one wallet (the shipped path: the probe
 * scripts in scripts/ call this, so what they verify is what the app sends).
 *
 * `spendableQuoteIn` is spent in full; `minBaseAmountOut` is the tokens it
 * buys at the quote-time reserves, discounted by `slippagePct`. Pure of any
 * send: only the SDK's builders run, no RPC beyond the state the caller read.
 */
export async function buildMigratedBuyIxs(opts: {
  sdk: PumpAmmSdk;
  /** The pool state the caller read (onlineSdk.swapSolanaState). */
  state: SwapSolanaState;
  /** SOL the buy spends, lamports: the WHOLE figure is committed. */
  spendableQuoteIn: bigint;
  /** The band (percent) under the quoted tokens, default
   *  POOL_BUY_SLIPPAGE_PCT. */
  slippagePct?: number;
}): Promise<{
  ixs: TransactionInstruction[];
  /** Tokens `spendableQuoteIn` buys at the quote-time reserves. */
  baseOut: bigint;
  /** The banded floor handed to the instruction (min_base_amount_out). */
  minBaseAmountOut: bigint;
}> {
  const { sdk, state, spendableQuoteIn } = opts;
  const slippagePct = opts.slippagePct ?? POOL_BUY_SLIPPAGE_PCT;
  if (spendableQuoteIn <= BigInt(0)) {
    throw new Error(
      `buy spendableQuoteIn must be positive, got ${spendableQuoteIn}`
    );
  }
  // The floor comes from the pool's CURRENT reserves; the wrap is the exact
  // spend. `buyInstructions(baseOut, maxQuoteIn)` is the SDK's own builder
  // (accounts + ATA create + WSOL wrap of maxQuoteIn + close), and is handed
  // maxQuoteIn = the exact spend, so the wrapped balance is exactly what
  // buy_exact_quote_in takes. Its `baseOut` argument only pre-fills a data
  // slot this module then rewrites.
  const baseOut = poolBuyBaseOut(state, spendableQuoteIn);
  const minBaseAmountOut = poolBuyMinBaseOut(baseOut, slippagePct);
  const ixs = await sdk.buyInstructions(
    state,
    new BN(baseOut.toString()),
    new BN(spendableQuoteIn.toString())
  );
  let rewrote = 0;
  const sendIxs = ixs.map((ix) => {
    if (
      !ix.programId.equals(PUMP_AMM_PROGRAM_ID) ||
      Buffer.from(ix.data).length !== PUMP_AMM_BUY_DATA_BYTES
    ) {
      return ix;
    }
    rewrote += 1;
    return toExactQuoteInBuy(ix, spendableQuoteIn, minBaseAmountOut);
  });
  if (rewrote !== 1) {
    throw new Error(
      `expected exactly ONE pump_amm buy instruction in the SDK stream, found ${rewrote}`
    );
  }
  return { ixs: sendIxs, baseOut, minBaseAmountOut };
}

/**
 * Buys base tokens on a migrated PumpSwap pool with an exact SOL input
 * (`quoteLamports`), spending ALL of it (`buy_exact_quote_in`). The SDK's own
 * stream builds the accounts, the base-ATA create when missing and the WSOL
 * wrap + close; `toExactQuoteInBuy` turns its `buy` instruction into the
 * exact-in one, with `min_base_amount_out` = the tokens `quoteLamports` buys
 * at the quote-time reserves, discounted by the slippage band. Retries
 * transient failures through the shared `sendRawWithRetry` (skipPreflight +
 * fresh blockhash).
 */
export async function buyMigratedPool(opts: {
  connection: Connection;
  poolKey: PublicKey;
  buyer: Keypair;
  /** SOL to spend, lamports. EXACT input: the whole figure is spent, and it
   *  is also the amount the SDK wraps as WSOL, so the wallet must hold it. */
  quoteLamports: bigint;
  /** Slippage PERCENT in [0, 100] (SDK unit), default POOL_BUY_SLIPPAGE_PCT
   *  (20): the floor on the tokens received. */
  slippagePct?: number;
}): Promise<MigratedBuyResult> {
  const {
    connection,
    poolKey,
    buyer,
    quoteLamports,
    slippagePct = POOL_BUY_SLIPPAGE_PCT,
  } = opts;
  if (quoteLamports <= BigInt(0)) {
    throw new Error(`buy quoteLamports must be positive, got ${quoteLamports}`);
  }
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  if (!poolInfo) throw poolNotFoundError(poolKey);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const state = await onlineSdk.swapSolanaState(poolKey, buyer.publicKey);
  const beforeTokens = await walletTokenBalance(
    connection,
    buyer.publicKey,
    state.baseMint
  );
  const beforeSol = BigInt(
    await connection.getBalance(buyer.publicKey, "confirmed")
  );
  const { ixs } = await buildMigratedBuyIxs({
    sdk,
    state,
    spendableQuoteIn: quoteLamports,
    slippagePct,
  });
  const tx = new Transaction({ feePayer: buyer.publicKey });
  tx.add(...ixs);
  const signature = await sendRawWithRetry(connection, tx, [buyer], {
    confirmTimeoutMs: 120_000,
  });
  const afterTokens = await walletTokenBalance(
    connection,
    buyer.publicKey,
    state.baseMint
  );
  const afterSol = BigInt(
    await connection.getBalance(buyer.publicKey, "confirmed")
  );
  return {
    signature,
    tokensOut: afterTokens > beforeTokens ? afterTokens - beforeTokens : BigInt(0),
    solSpentLamports: beforeSol > afterSol ? beforeSol - afterSol : BigInt(0),
  };
}

/**
 * Sells an exact base-token amount on a migrated PumpSwap pool. `sellBaseInput`
 * quotes a fresh minQuoteAmountOut from the live pool reserves under the
 * slippage band; the SDK's sell stream closes the seller's WSOL account, so
 * the proceeds land as native SOL.
 */
export async function sellMigratedPool(opts: {
  connection: Connection;
  poolKey: PublicKey;
  seller: Keypair;
  /** Base tokens to sell (raw Token-2022 units). */
  baseAmount: bigint;
  /** Slippage PERCENT in [0, 100] (SDK unit), default POOL_SELL_SLIPPAGE_PCT
   *  (100 = a ZERO floor): the floor on the SOL received. */
  slippagePct?: number;
  /** Stage 2: exact minimum quote out (lamports), used INSTEAD of the
   *  slippagePct derivation when present. The SDK quotes in percent, so a
   *  FOLDED floor cannot be expressed as one; `sellInstructions` is the same
   *  builder `sellBaseInput` funnels into, only with the min-out handed in
   *  directly. This call takes the LOOSER of the handed-in floor and the
   *  percent floor (poolPercentFloor), so an explicit floor can only ever
   *  loosen the trade, never tighten it. */
  minOutLamports?: bigint;
}): Promise<MigratedSellResult> {
  const {
    connection,
    poolKey,
    seller,
    baseAmount,
    slippagePct = POOL_SELL_SLIPPAGE_PCT,
    minOutLamports,
  } = opts;
  if (baseAmount <= BigInt(0)) {
    throw new Error(`sell baseAmount must be positive, got ${baseAmount}`);
  }
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  if (!poolInfo) throw poolNotFoundError(poolKey);

  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const state = await onlineSdk.swapSolanaState(poolKey, seller.publicKey);
  const beforeSol = BigInt(
    await connection.getBalance(seller.publicKey, "confirmed")
  );
  const base = new BN(baseAmount.toString());
  let ixs: TransactionInstruction[];
  if (minOutLamports === undefined) {
    ixs = await sdk.sellBaseInput(state, base, slippagePct);
  } else {
    // The explicit (folded) floor may only ever LOOSEN the trade: see
    // poolPercentFloor for why the fold's own floor can come out a lamport
    // TIGHTER than the percent path.
    const percentFloor = poolPercentFloor(state, baseAmount, slippagePct);
    const floor = minOutLamports < percentFloor ? minOutLamports : percentFloor;
    ixs = await sdk.sellInstructions(state, base, new BN(floor.toString()));
  }
  const tx = new Transaction({ feePayer: seller.publicKey });
  tx.add(...ixs);
  const signature = await sendRawWithRetry(connection, tx, [seller], {
    confirmTimeoutMs: 120_000,
  });
  const afterSol = BigInt(
    await connection.getBalance(seller.publicKey, "confirmed")
  );
  return {
    signature,
    tokensIn: baseAmount,
    solReceivedLamports: afterSol > beforeSol ? afterSol - beforeSol : BigInt(0),
  };
}
