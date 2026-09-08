// Milestone M8A (2026-09-03): the MANUAL Buy/Sell engine (Feature 1), now on
// pump.fun's NATIVE program (M10).
//
// One click trades every SELECTED keyed managed wallet, mirroring the exact
// semantics of v4-launchpad's "Buy / Sell" tab but on the pump.fun Solana
// client:
//
//   - Buy (MAX, 2026-09-08; flat-keep commit): for every selected keyed
//     wallet, spend its TOTAL SOL balance minus a flat 0.002 SOL keep, the
//     5,000-lamport base tx fee, and the Token-2022 ATA rent ONLY when the
//     wallet's ATA for this mint does not exist yet, quoted at zero slippage
//     so max_sol_cost = solIn = budget exactly. NO rent-floor reserve, NO
//     fee margin, NO slippage-band discount (the old budget / 1.10 sizing
//     left ~10% of the spendable balance unbought; the 2026-09-08 band
//     commit is gone). A wallet ends at exactly 0.002 SOL after the buy.
//     Skipped when the balance cannot cover the keep + ATA rent + base fee.
//   - Sell: for every selected keyed wallet, sell sellPct% of the wallet's
//     current token balance of the tracked mint (walletTokenBalance).
//     Skipped when the balance is zero.
//
// Trade execution is the v4 batch pattern used across M5/M6: each wallet's
// trade is its OWN signed tx (the wallet is the fee payer), fired
// concurrently with Promise.allSettled, and only the final completed count
// plus the confirmed signatures are reported. Instructions come from
// lib/pump.ts's buildPumpBuyIx (max buy, quoted client-side with quotePumpBuy)
// / lib/auto.ts's buildAutoSellIx (pump.fun ixs: buy takes tokens_out +
// max_sol_cost, sell takes tokens_in + min_sol_output quoted client-side
// against the VIRTUAL reserves; the curve's creator feeds the creator_vault
// fee leg) and sends
//     go through sendAndConfirmWithRetry (a NORMAL raw-RPC tx, never Helius).
//     BUYS now send exactly like SELLS: a plain raw-RPC tx with no SWQOS tip
//     and no priority fee. (The old Helius Sender SWQOS path for buys was
//     removed — its tip + priority fee exceed a small wallet's SOL headroom
//     and can reject the buy before it lands.)
//
// The curve state (creator + VIRTUAL reserves) is read by the CALLER before
// this module runs (the trade panel's round gate) and passed in, so both
// the gate and the batch quote against the same snapshot.
//
// All amounts are bigint (no bigint literals, project target is ES2017);
// every tx is signed manually with the wallet's Keypair (anchor Wallet is
// Node-only in the browser, and the anchor Program is gone entirely).

import bs58 from "bs58";
import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  AUTO_CONFIRM_TIMEOUT_MS,
  buildAutoSellIx,
  type AutoCurveInfo,
  type AutoWallet,
} from "./auto";
import {
  sendAndConfirmWithRetry,
  walletTokenBalance,
} from "./bundle/launch";
import type { SendTx } from "./bundle/protected-send";
import { MAX_BUY_KEEP_SOL_LAMPORTS } from "./params";
import {
  buildPumpBuyIx,
  quotePumpBuy,
  resolvePumpFeeRecipient,
} from "./pump";

/** Single-signature legacy tx base fee (lamports). A manual buy is one signer
 *  (the wallet) on a plain raw-RPC tx, so the base fee is exactly 5,000 — the
 *  max-buy budget reserves it precisely so the wallet lands exactly at its
 *  0.002 SOL keep. */
const MANUAL_TX_BASE_FEE_LAMPORTS: bigint = BigInt(5_000);

/** Final outcome of one manual batch trade (the v4 batch pattern). */
export interface ManualBatchResult {
  /** Wallets whose tx confirmed on-chain. */
  completed: number;
  /** Wallets whose tx failed (build/send/confirm error). */
  failed: number;
  /** Wallets with nothing tradeable (no spendable SOL / no tokens). */
  skipped: number;
  /** Confirmed transaction signatures, one per completed wallet. */
  signatures: string[];
}

export interface BuySelectedOptions {
  connection: Connection;
  /** The curve mint being bought. */
  mint: PublicKey;
  /** Fetched curve state; the creator feeds the buy instruction's
   *  creator_vault leg and the VIRTUAL reserves feed the tokens_out quote. */
  curve: AutoCurveInfo;
  /** Selected keyed managed wallets to buy for. */
  wallets: AutoWallet[];
}

export interface SellSelectedOptions {
  connection: Connection;
  /** The curve mint being sold. */
  mint: PublicKey;
  /** Fetched curve state; the creator feeds the sell instruction's
   *  creator_vault leg and the VIRTUAL reserves feed the min_sol_output
   *  quote. */
  curve: AutoCurveInfo;
  /** Selected keyed managed wallets to sell for. */
  wallets: AutoWallet[];
  /** % of each wallet's OWN token balance to sell, clamped to (0, 100].
   *  Blank/invalid input is resolved by the caller's parse (default 100). */
  sellPct?: number;
}

/** Clamps a percentage to the open interval (0, 100]; a non-finite or
 *  non-positive value (blank/invalid input that slipped past the parse)
 *  falls back to the given default. */
function clampPct(pct: number, fallback: number): number {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(100, n);
}

/** Round basis points for a percent (95 -> 9500), matching fireAutoBuy /
 *  fireAutoSell so the UI default (95 / 100) and the engine agree. */
function pctNum(pct: number): number {
  return Math.round(clampPct(pct, 0) * 100);
}

/** One MAX-buy worker: spends the wallet's TOTAL SOL balance minus a flat
 *  0.002 SOL keep (MAX_BUY_KEEP_SOL_LAMPORTS) plus the 5,000-lamport base
 *  tx fee (the wallet is its own fee payer) plus the Token-2022 ATA rent
 *  ONLY when the wallet's ATA for this mint does not exist yet (the buy's
 *  ATA-create ix bills the wallet; once it exists the rent is skipped so the
 *  wallet buys that much more). Quoted at ZERO slippage so
 *  max_sol_cost = solIn = budget: every lamport above the keep + ATA rent
 *  goes into the curve, and the wallet ends at exactly 0.002 SOL (no
 *  rent-floor reserve, no slippage-band discount). Resolves the confirmed
 *  signature, or null when skipped (live balance cannot cover the keep + ATA
 *  rent + base fee). Throws on build/send/confirm errors so the settled
 *  count reports the wallet as failed. */
async function buyOne(
  connection: Connection,
  mint: PublicKey,
  curve: AutoCurveInfo,
  wallet: AutoWallet,
  ataRent: number,
  latest: { blockhash: string; lastValidBlockHeight: number },
  /** Live protocol fee recipient (resolvePumpFeeRecipient), resolved once
   *  per batch. */
  feeRecipient: PublicKey,
  /** Send + confirm fn (normal raw-RPC, same as sells). */
  send: SendTx
): Promise<string | null> {
  const kp = Keypair.fromSecretKey(bs58.decode(wallet.key));
  const live = BigInt(await connection.getBalance(kp.publicKey, "confirmed"));
  const ata = getAssociatedTokenAddressSync(
    mint,
    kp.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const ataInfo = await connection.getAccountInfo(ata, "confirmed");
  const reserveAta = ataInfo ? BigInt(0) : BigInt(ataRent);
  // MAX budget (flat keep + ATA rent only when the ATA is missing): spend
  // the TOTAL balance minus a flat 0.002 SOL keep, the wallet's own
  // 5,000-lamport base tx fee, and the Token-2022 ATA rent ONLY when the ATA
  // does not exist yet (the buy's ATA-create ix bills it). No
  // rent-exempt-floor reserve, no fee margin, no slippage-band discount: the
  // wallet ends at exactly 0.002 SOL after the buy and every other lamport is
  // committed to the curve.
  const budget =
    live - MAX_BUY_KEEP_SOL_LAMPORTS - reserveAta - MANUAL_TX_BASE_FEE_LAMPORTS;
  if (budget <= BigInt(0)) return null;
  // Full spend at ZERO slippage: solIn = budget, so max_sol_cost = budget =
  // solIn and the program's cost check can never pull the wallet below its
  // 0.002 keep. (The 10% band is deliberately gone: under it the quote only
  // committed budget / 1.10, leaving ~9% of the balance unbought whenever
  // the curve did not drift.)
  const solIn = budget;
  const creator = new PublicKey(curve.creator);
  const quote = quotePumpBuy({
    solInLamports: solIn,
    virtualSolReserves: curve.solReserve,
    virtualTokenReserves: curve.tokenReserve,
    slippageBps: BigInt(0),
  });
  const ixs = buildPumpBuyIx({
    mint,
    buyer: kp.publicKey,
    creator,
    feeRecipient,
    tokensOut: quote.tokensOut,
    // max_sol_cost = solIn = budget: every lamport above the flat keep is
    // committed; any live-curve tick ABOVE the quote reverts (Custom 6002)
    // rather than overdrawing the wallet below its 0.002 keep.
    maxSolCost: budget,
  });
  const tx = new Transaction({
    feePayer: kp.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx.add(...ixs);
  const { signature } = await send(connection, tx, [kp], {
    attempts: 2,
    confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
    label: "manual buy max",
  });
  return signature;
}

/** One sell worker: sells sellPct% of the wallet's OWN token balance.
 *  Resolves the confirmed signature, or null when skipped (zero balance).
 *  Throws on build/send/confirm errors so the settled count reports the
 *  wallet as failed. */
async function sellOne(
  connection: Connection,
  mint: PublicKey,
  curve: AutoCurveInfo,
  wallet: AutoWallet,
  pct: number,
  latest: { blockhash: string; lastValidBlockHeight: number },
  /** Live protocol fee recipient (resolvePumpFeeRecipient), resolved once
   *  per batch. */
  feeRecipient: PublicKey,
  /** Send + confirm fn: sells always use sendAndConfirmWithRetry (a NORMAL
   *  raw-RPC tx, never Helius). */
  send: SendTx
): Promise<string | null> {
  const kp = Keypair.fromSecretKey(bs58.decode(wallet.key));
  const balance = await walletTokenBalance(connection, kp.publicKey, mint);
  if (balance <= BigInt(0)) return null;
  const tokenIn = (balance * BigInt(pctNum(pct))) / BigInt(10_000);
  if (tokenIn <= BigInt(0)) return null;
  const creator = new PublicKey(curve.creator);
  const ixs = buildAutoSellIx({
    seller: kp.publicKey,
    mint,
    creator,
    feeRecipient,
    tokenIn,
    solReserve: curve.solReserve,
    tokenReserve: curve.tokenReserve,
  });
  const tx = new Transaction({
    feePayer: kp.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx.add(...ixs);
  const { signature } = await send(connection, tx, [kp], {
    attempts: 2,
    confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
    label: "manual sell",
  });
  return signature;
}

/** Tallies an allSettled batch into the ManualBatchResult shape. */
function tally(
  settled: PromiseSettledResult<string | null>[]
): ManualBatchResult {
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const signatures: string[] = [];
  for (const r of settled) {
    if (r.status === "fulfilled" && r.value !== null) {
      completed += 1;
      signatures.push(r.value);
    } else if (r.status === "fulfilled") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  return { completed, failed, skipped, signatures };
}

/**
 * Max-buys every selected keyed wallet: each spends its TOTAL SOL balance
 * minus a flat 0.002 SOL keep plus the base tx fee plus the Token-2022 ATA
 * rent ONLY when that wallet's ATA for the mint is missing, quoted at ZERO
 * slippage so max_sol_cost = solIn = budget exactly. The wallet ends at
 * exactly 0.002 SOL (no rent-floor reserve, no fee margin, no slippage-band
 * discount; the ATA rent is reserved only when the ATA does not exist yet,
 * so a re-buy that already holds the ATA does not strand that rent).
 * Skipped = balance cannot cover the keep + ATA rent + base fee; failed =
 * build/send/confirm error; completed = confirmed on-chain (signatures
 * collected). The shared blockhash is fetched ONCE for the whole batch (the
 * v4 batch pattern).
 */
export async function buySelectedWallets(
  opts: BuySelectedOptions
): Promise<ManualBatchResult> {
  const { connection, mint, curve, wallets } = opts;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0, signatures: [] };
  }
  const ataRent = await connection.getMinimumBalanceForRentExemption(
    170,
    "confirmed"
  );
  const latest = await connection.getLatestBlockhash("confirmed");
  // Live protocol fee recipient (pump.fun rotates it; stale -> Custom 6000).
  const feeRecipient = await resolvePumpFeeRecipient(connection);
  // Normal raw-RPC send (sendAndConfirmWithRetry): buys send exactly like
  // sells, no Helius Sender / SWQOS tip / priority fee.
  const send = sendAndConfirmWithRetry;
  const settled = await Promise.allSettled(
    wallets.map((w) =>
      buyOne(connection, mint, curve, w, ataRent, latest, feeRecipient, send)
    )
  );
  return tally(settled);
}

/**
 * Sells sellPct% of every selected keyed wallet's own token balance of the
 * mint, one signed tx per wallet, concurrently. Skipped = zero balance;
 * failed = build/send/confirm error; completed = confirmed on-chain
 * (signatures collected). The shared blockhash is fetched ONCE for the
 * whole batch (the v4 batch pattern).
 */
export async function sellSelectedWallets(
  opts: SellSelectedOptions
): Promise<ManualBatchResult> {
  const { connection, mint, curve, wallets } = opts;
  const sellPct = clampPct(opts.sellPct ?? 100, 100);
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0, signatures: [] };
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  // Live protocol fee recipient (pump.fun rotates it; stale -> Custom 6000).
  const feeRecipient = await resolvePumpFeeRecipient(connection);
  // Plain raw-RPC send (sendAndConfirmWithRetry): sells are NORMAL txs, never
  // routed through Helius Sender SWQOS (its tip + priority fee would exceed a
  // seller wallet's SOL headroom and reject the tx before it lands).
  const send = sendAndConfirmWithRetry;
  const settled = await Promise.allSettled(
    wallets.map((w) =>
      sellOne(connection, mint, curve, w, sellPct, latest, feeRecipient, send)
    )
  );
  return tally(settled);
}
