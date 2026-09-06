// Milestone M8A (2026-09-03): the MANUAL Buy/Sell engine (Feature 1), now on
// pump.fun's NATIVE program (M10).
//
// One click trades every SELECTED keyed managed wallet at a % of that
// wallet's own balance, mirroring the exact semantics of v4-launchpad's
// "Buy / Sell" tab but on the pump.fun Solana client:
//
//   - Buy: for every selected keyed wallet, buy buyPct% of the wallet's
//     SPENDABLE SOL balance (the fireAutoBuy spendable formula: live SOL
//     minus the rent-exempt floor, the tx fee reserve, and the legacy-SPL
//     ATA rent when the ATA does not exist yet). Skipped when there is
//     nothing tradeable after those reserves.
//   - Sell: for every selected keyed wallet, sell sellPct% of the wallet's
//     current token balance of the tracked mint (walletTokenBalance).
//     Skipped when the balance is zero.
//
// Trade execution is the v4 batch pattern used across M5/M6: each wallet's
// trade is its OWN signed tx (the wallet is the fee payer), fired
// concurrently with Promise.allSettled, and only the final completed count
// plus the confirmed signatures are reported. Instructions come from
// lib/auto.ts's buildAutoBuyIx / buildAutoSellIx (lib/pump.ts hand-built
// pump.fun ixs: buy/sell take tokens_out/tokens_in quoted client-side with
// slippage; the curve's creator feeds the creator_vault fee leg) and sends
// go through lib/bundle/protected-send.ts's makeProtectedSender: on MAINNET
// each trade is submitted to Helius Sender Max (sender.helius-rpc.com/fast,
// priority fee + tip, mev-protect) so the whole batch is front-running-
// protected; on devnet it falls back to sendAndConfirmWithRetry (expiry-safe
// re-sends only, never a blind double-fire).
//
// The curve state (creator + VIRTUAL reserves) is read by the CALLER before
// this module runs (the trade panel's round gate) and passed in, so both
// the gate and the batch quote against the same snapshot.
//
// All amounts are bigint (no bigint literals, project target is ES2017);
// every tx is signed manually with the wallet's Keypair (anchor Wallet is
// Node-only in the browser, and the anchor Program is gone entirely).

import { TOKEN_2022_PROGRAM_ID, getAssociatedTokenAddressSync } from "@solana/spl-token";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  AUTO_CONFIRM_TIMEOUT_MS,
  AUTO_TX_FEE_RESERVE_LAMPORTS,
  buildAutoBuyIx,
  buildAutoSellIx,
  type AutoCurveInfo,
  type AutoWallet,
} from "./auto";
import {
  RENT_EXEMPT_FLOOR,
  walletTokenBalance,
} from "./bundle/launch";
import {
  makeProtectedSender,
  protectedReserveLamports,
  type SendTx,
} from "./bundle/protected-send";
import { resolvePumpFeeRecipient } from "./pump";

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
  /** The curve mint being bought (legacy SPL). */
  mint: PublicKey;
  /** Fetched curve state; the creator feeds the buy instruction's
   *  creator_vault leg and the VIRTUAL reserves feed the tokens_out quote. */
  curve: AutoCurveInfo;
  /** Selected keyed managed wallets to buy for. */
  wallets: AutoWallet[];
  /** % of each wallet's spendable SOL balance to buy, clamped to (0, 100].
   *  Blank/invalid input is resolved by the caller's parse (default 95). */
  buyPct?: number;
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

/** One buy worker: buys buyPct% of the wallet's spendable SOL balance.
 *  Resolves the confirmed signature, or null when skipped (nothing
 *  tradeable). Throws on build/send/confirm errors so the settled count
 *  reports the wallet as failed. */
async function buyOne(
  connection: Connection,
  mint: PublicKey,
  curve: AutoCurveInfo,
  wallet: AutoWallet,
  pct: number,
  ataRent: number,
  latest: { blockhash: string; lastValidBlockHeight: number },
  /** Live protocol fee recipient (resolvePumpFeeRecipient), resolved once
   *  per batch. */
  feeRecipient: PublicKey,
  /** Send + confirm fn (Jito-protected on mainnet, plain RPC on devnet),
   *  resolved once per batch by makeProtectedSender. */
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
  const spendable =
    live -
    BigInt(RENT_EXEMPT_FLOOR) -
    AUTO_TX_FEE_RESERVE_LAMPORTS -
    BigInt(protectedReserveLamports()) -
    reserveAta;
  if (spendable <= BigInt(0)) return null;
  const solIn = (spendable * BigInt(pctNum(pct))) / BigInt(10_000);
  if (solIn <= BigInt(0)) return null;
  const creator = new PublicKey(curve.creator);
  const ixs = buildAutoBuyIx({
    buyer: kp.publicKey,
    mint,
    creator,
    feeRecipient,
    solInLamports: solIn,
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
    label: "manual buy",
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
  /** Send + confirm fn (Jito-protected on mainnet, plain RPC on devnet),
   *  resolved once per batch by makeProtectedSender. */
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
 * Buys buyPct% of every selected keyed wallet's spendable SOL balance from
 * the curve, one signed tx per wallet, concurrently. Skipped = no spendable
 * SOL after the rent/fee/ATA reserves; failed = build/send/confirm error;
 * completed = confirmed on-chain (signatures collected). The shared
 * blockhash is fetched ONCE for the whole batch (the v4 batch pattern).
 */
export async function buySelectedWallets(
  opts: BuySelectedOptions
): Promise<ManualBatchResult> {
  const { connection, mint, curve, wallets } = opts;
  const buyPct = clampPct(opts.buyPct ?? 95, 95);
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
  // Jito-protected sender on mainnet (plain RPC on devnet), one per batch.
  const send = await makeProtectedSender();
  const settled = await Promise.allSettled(
    wallets.map((w) =>
      buyOne(
        connection,
        mint,
        curve,
        w,
        buyPct,
        ataRent,
        latest,
        feeRecipient,
        send
      )
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
  // Jito-protected sender on mainnet (plain RPC on devnet), one per batch.
  const send = await makeProtectedSender();
  const settled = await Promise.allSettled(
    wallets.map((w) =>
      sellOne(connection, mint, curve, w, sellPct, latest, feeRecipient, send)
    )
  );
  return tally(settled);
}
