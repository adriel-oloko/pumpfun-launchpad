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

import { BN } from "@coral-xyz/anchor";
import { OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
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
 * Buys base tokens on a migrated PumpSwap pool with an exact SOL input
 * (`quoteLamports`). `buyQuoteInput` quotes the base amount out under the
 * slippage band and prepends the buyer's base-ATA create when missing, so a
 * fresh buyer needs no setup. Retries transient failures through the shared
 * `sendRawWithRetry` (skipPreflight + fresh blockhash).
 */
export async function buyMigratedPool(opts: {
  connection: Connection;
  poolKey: PublicKey;
  buyer: Keypair;
  /** SOL to spend, lamports. Exact input (the SDK grosses up for fees within
   *  the slippage band). */
  quoteLamports: bigint;
  /** Slippage PERCENT in [0, 100] (SDK unit), default 5. */
  slippagePct?: number;
}): Promise<MigratedBuyResult> {
  const { connection, poolKey, buyer, quoteLamports, slippagePct = 5 } = opts;
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
  const ixs = await sdk.buyQuoteInput(
    state,
    new BN(quoteLamports.toString()),
    slippagePct
  );
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
  /** Slippage PERCENT in [0, 100] (SDK unit), default 5. */
  slippagePct?: number;
  /** Stage 2: exact minimum quote out (lamports), used INSTEAD of the
   *  slippagePct derivation when present. The SDK quotes in percent, so a
   *  FOLDED floor cannot be expressed as one; `sellInstructions` is the same
   *  builder `sellBaseInput` funnels into, only with the min-out handed in
   *  directly. The caller guarantees it is not tighter than the percent path
   *  would have produced. */
  minOutLamports?: bigint;
}): Promise<MigratedSellResult> {
  const {
    connection,
    poolKey,
    seller,
    baseAmount,
    slippagePct = 5,
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
  const ixs =
    minOutLamports === undefined
      ? await sdk.sellBaseInput(
          state,
          new BN(baseAmount.toString()),
          slippagePct
        )
      : await sdk.sellInstructions(
          state,
          new BN(baseAmount.toString()),
          new BN(minOutLamports.toString())
        );
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
