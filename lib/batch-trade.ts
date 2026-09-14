// Milestone M8A (2026-09-03): the MANUAL Buy/Sell engine (Feature 1), now on
// pump.fun's NATIVE program (M10).
//
// One click trades every SELECTED keyed managed wallet, mirroring the exact
// semantics of v4-launchpad's "Buy / Sell" tab but on the pump.fun Solana
// client:
//
//   - Buy (MAX, 2026-09-08; flat-keep commit, exact-in since 2026-09-14): for
//     every selected keyed wallet, spend its TOTAL SOL balance minus a flat
//     0.002 SOL keep, the 5,000-lamport base tx fee, and the Token-2022 ATA
//     rent ONLY when the wallet's ATA for this mint does not exist yet. The buy
//     goes out as `buy_exact_sol_in(spendable_sol_in, min_tokens_out)`: the
//     whole budget is SPENT and CURVE_BUY_SLIPPAGE_BPS (20%) is held as a floor on
//     the tokens received. A wallet ends at exactly 0.002 SOL when the curve
//     has not moved. Skipped when the balance cannot cover the keep + ATA rent
//     + base fee.
//     (History: until 2026-09-14 the curve buy was the token-exact-out
//     `buy(tokens_out, max_sol_cost)` at ZERO band, because a band on that
//     shape can only be funded by committing budget / (1 + s) — the reverted
//     2026-09-08 /1.10 experiment that left ~9% of the balance unbought — and
//     at a zero band ANY adverse tick reverted with Custom 6002. The curve
//     program's own exact-in instruction removes that trade-off; it is the twin
//     of the migrated venue's buy_exact_quote_in.)
//   - Sell: for every selected keyed wallet, sell sellPct% of the wallet's
//     current token balance of the tracked mint (walletTokenBalance). The
//     curve sell carries CURVE_SELL_SLIPPAGE_BPS (10000 = a ZERO floor) as
//     min_sol_output (zero at the operator's 100% sell band: an exit is never
//     refused on price). Skipped when the balance is zero.
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
// MIGRATED VENUE (2026-09, band + exact-in 2026-09-14): a GRADUATED mint
// (curve `complete` = 1) has no tradable curve left (curve buy/sell revert
// on-chain), so the manual BUY MAX routes to the PumpSwap AMM instead:
// buySelectedWalletsMigrated buys on the canonical pool through lib/swap.ts's
// buyMigratedPool, which builds the program's EXACT-IN buy_exact_quote_in.
// The budget follows the curve leg's rule exactly (total balance minus the
// flat 0.002 SOL keep, the 5,000-lamport base fee, and only the rents the tx
// must actually create) and is spent in FULL, with POOL_BUY_SLIPPAGE_PCT (20%)
// held as a floor on the tokens received rather than as headroom above the
// price: a fill up to 20% worse still lands, and the wallet still ends at its
// keep. (Before 2026-09-14 the pool buy used the SDK's plain `buy` at ZERO
// slippage, where maxQuoteAmountIn == the exact quote-time price, so any tick
// between the quote and the landing reverted with pump_amm 6040 and only the
// first buy of a concurrent batch could ever land.) The SELL routes there too:
// sellSelectedWalletsMigrated sells sellPct% of each selected wallet's balance
// on the same pool through lib/sell-all.ts's per-wallet pool leg
// (sellOneWalletOnPool) under the identical policy Sell All uses (fresh quote
// per attempt, POOL_SELL_SLIPPAGE_PCT under the quote (100 = no floor), folded floors over the
// selected subset, its own retry budgets), so a graduated mint no longer has
// to leave this panel to be sold.
//
// All amounts are bigint (no bigint literals, project target is ES2017);
// every tx is signed manually with the wallet's Keypair (anchor Wallet is
// Node-only in the browser, and the anchor Program is gone entirely).

import bs58 from "bs58";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
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
import { WSOL_MINT } from "./migrate";
import { CURVE_BUY_SLIPPAGE_BPS, CURVE_SELL_SLIPPAGE_BPS, MAX_BUY_KEEP_SOL_LAMPORTS } from "./params";
import {
  buildPumpBuyExactSolInIx,
  quotePumpBuyExactIn,
  resolvePumpFeeRecipient,
} from "./pump";
import {
  MAX_SLIPPAGE_PCT,
  planFoldedFloors,
  sellOneWalletOnPool,
} from "./sell-all";
import {
  buyMigratedPool,
  POOL_BUY_SLIPPAGE_PCT,
  POOL_SELL_SLIPPAGE_PCT,
} from "./swap";

/** Single-signature legacy tx base fee (lamports). A manual buy is one signer
 *  (the wallet) on a plain raw-RPC tx, so the base fee is exactly 5,000 — the
 *  max-buy budget reserves it precisely so the wallet lands exactly at its
 *  0.002 SOL keep. */
const MANUAL_TX_BASE_FEE_LAMPORTS: bigint = BigInt(5_000);

/** Token-2022 ATA size: 165 bytes of SPL account data + the 1-byte account
 *  type + the 4-byte ImmutableOwner extension header. The MAX-buy budget
 *  reserves this rent only when the wallet's ATA for the mint does not exist
 *  yet (the buy's idempotent ATA-create ix bills the buyer). */
const TOKEN_2022_ATA_RENT_BYTES = 170;

/** Legacy SPL Token ATA size: the WSOL account a PumpSwap buy wraps its SOL
 *  into. Reserved only when the buyer has no WSOL ATA yet — the SDK creates
 *  it inside the buy tx and CLOSES it at the end of that same tx, so the rent
 *  comes straight back to the wallet; it only has to be AVAILABLE at send
 *  time. */
const WSOL_ATA_RENT_BYTES = 165;

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
 *  wallet buys that much more). The buy is EXACT-IN
 *  (`buildPumpBuyExactSolInIx`) at CURVE_BUY_SLIPPAGE_BPS (20%) held as a floor on
 *  the tokens received, so the whole budget is spent AND an adverse tick up to
 *  the band still lands; the wallet ends at exactly 0.002 SOL at par.
 *  Resolves the confirmed signature, or null when skipped (live balance cannot
 *  cover the keep + ATA rent + base fee). Throws on build/send/confirm errors
 *  so the settled count reports the wallet as failed. */
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
  // Full spend: the exact-in instruction takes the WHOLE budget and spends it,
  // so the band cannot be "paid for" out of it and nothing is held back.
  const solIn = budget;
  const creator = new PublicKey(curve.creator);
  // EXACT-IN: the whole budget is spent, and the band is a FLOOR on the tokens
  // received (min_tokens_out). The old token-exact-out shape could only carry a
  // band by committing budget / (1 + s) — the reverted 2026-09-08 shape — and
  // at a ZERO band any adverse tick reverted with TooMuchSolRequired (6002).
  const quote = quotePumpBuyExactIn({
    solInLamports: solIn,
    virtualSolReserves: curve.solReserve,
    virtualTokenReserves: curve.tokenReserve,
    slippageBps: CURVE_BUY_SLIPPAGE_BPS,
  });
  const ixs = buildPumpBuyExactSolInIx({
    mint,
    buyer: kp.publicKey,
    creator,
    feeRecipient,
    // Every lamport above the flat keep is committed; the program spends
    // exactly this and only reverts if the tokens come out below the floor.
    spendableSolIn: budget,
    minTokensOut: quote.minTokensOut,
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
    // The operator's SELL band (CURVE_SELL_SLIPPAGE_BPS, 10000 = a ZERO
    // floor): the curve sell is never refused on price, so an exit always
    // lands. That is the point of 10000 (see the constant's note for the
    // on-chain trade-off it accepts).
    slippageBps: CURVE_SELL_SLIPPAGE_BPS,
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
    TOKEN_2022_ATA_RENT_BYTES,
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

/* ------------------------------------------------------------------ */
/* Migrated venue: the manual BUY MAX once the curve graduated         */
/* ------------------------------------------------------------------ */

export interface BuyMigratedSelectedOptions {
  connection: Connection;
  /** The graduated mint (it IS the PumpSwap pool's base mint). */
  mint: PublicKey;
  /** The canonical PumpSwap pool the mint migrated to (derive it with
   *  canonicalMigratedPoolPda, lib/migrate.ts). */
  poolKey: PublicKey;
  /** Selected keyed managed wallets to buy for. */
  wallets: AutoWallet[];
  /** Slippage PERCENT for the pool quote (the SDK's 0-100 unit), default
   *  POOL_BUY_SLIPPAGE_PCT (20). The buy is EXACT-IN (lib/swap.ts): the whole
   *  budget is spent and this band is a floor on the tokens received
   *  (buy_exact_quote_in's min_base_amount_out), NOT headroom the wallet has
   *  to fund, so a larger band never leaves SOL unbought. */
  slippagePct?: number;
}

/** MAX-buy budget for ONE wallet on the migrated venue: the wallet's total SOL
 *  minus the flat 0.002 SOL keep (MAX_BUY_KEEP_SOL_LAMPORTS), its own
 *  5,000-lamport base tx fee, and the rent of any account the buy tx has to
 *  CREATE (the Token-2022 base ATA, and the WSOL account the SDK wraps the SOL
 *  into). Callers pass 0 for an ATA that already exists. Returns 0 when
 *  nothing is left to spend (the caller reports that wallet as skipped). Pure:
 *  the SDK wraps exactly the budget figure as WSOL, so the wallet ends at its
 *  keep. */
export function poolBuyBudgetLamports(opts: {
  liveLamports: bigint;
  /** Rent of the mint's Token-2022 ATA (0 when it already exists). */
  baseAtaRentLamports: bigint;
  /** Rent of the wallet's WSOL ATA (0 when it already exists). The SDK closes
   *  that account inside the buy tx, so this rent comes back to the wallet. */
  wsolAtaRentLamports: bigint;
}): bigint {
  const budget =
    opts.liveLamports -
    MAX_BUY_KEEP_SOL_LAMPORTS -
    MANUAL_TX_BASE_FEE_LAMPORTS -
    opts.baseAtaRentLamports -
    opts.wsolAtaRentLamports;
  return budget > BigInt(0) ? budget : BigInt(0);
}

/** One MAX-buy worker on the migrated venue: sizes the wallet's budget, then
 *  buys with it on the PumpSwap pool (lib/swap.ts). Resolves the confirmed
 *  signature, or null when skipped (the live balance cannot cover the keep +
 *  the rents + the base fee). Throws on build/send/confirm errors so the
 *  settled count reports the wallet as failed. */
async function buyMigratedOne(
  connection: Connection,
  mint: PublicKey,
  poolKey: PublicKey,
  wallet: AutoWallet,
  /** Rent of the two possibly-missing ATAs, read once per batch. */
  rent: { baseAtaLamports: bigint; wsolAtaLamports: bigint },
  slippagePct: number
): Promise<string | null> {
  const kp = Keypair.fromSecretKey(bs58.decode(wallet.key));
  const live = BigInt(await connection.getBalance(kp.publicKey, "confirmed"));
  // The ATAs the buy tx creates when they are missing (the same derivations
  // the SDK uses: base under the mint's Token-2022 program, quote = WSOL
  // under the legacy token program).
  const baseAta = getAssociatedTokenAddressSync(
    mint,
    kp.publicKey,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const wsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    kp.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const [baseInfo, wsolInfo] = await Promise.all([
    connection.getAccountInfo(baseAta, "confirmed"),
    connection.getAccountInfo(wsolAta, "confirmed"),
  ]);
  const budget = poolBuyBudgetLamports({
    liveLamports: live,
    baseAtaRentLamports: baseInfo ? BigInt(0) : rent.baseAtaLamports,
    wsolAtaRentLamports: wsolInfo ? BigInt(0) : rent.wsolAtaLamports,
  });
  if (budget <= BigInt(0)) return null;
  const { signature } = await buyMigratedPool({
    connection,
    poolKey,
    buyer: kp,
    quoteLamports: budget,
    slippagePct,
  });
  return signature;
}

/**
 * MAX-buys the mint on the PumpSwap pool for every selected keyed wallet
 * (the graduated route): each spends its TOTAL SOL balance minus the flat
 * 0.002 SOL keep and the mechanical costs described above, one signed tx per
 * wallet, concurrently (Promise.allSettled, the v4 batch pattern), tallied
 * into the same ManualBatchResult shape the curve leg returns. The pool
 * account is read ONCE before the batch: a mint that reports graduated but has
 * no pool behind it fails the whole run with a clean error instead of firing
 * N wallets into a dead pool.
 */
export async function buySelectedWalletsMigrated(
  opts: BuyMigratedSelectedOptions
): Promise<ManualBatchResult> {
  const {
    connection,
    mint,
    poolKey,
    wallets,
    slippagePct = POOL_BUY_SLIPPAGE_PCT,
  } = opts;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0, signatures: [] };
  }
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  if (!poolInfo) {
    throw new Error(
      `PUMPSWAP POOL ${poolKey.toBase58()} NOT FOUND (NOT MIGRATED?)`
    );
  }
  const [baseAtaRent, wsolAtaRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(
      TOKEN_2022_ATA_RENT_BYTES,
      "confirmed"
    ),
    connection.getMinimumBalanceForRentExemption(
      WSOL_ATA_RENT_BYTES,
      "confirmed"
    ),
  ]);
  const rent = {
    baseAtaLamports: BigInt(baseAtaRent),
    wsolAtaLamports: BigInt(wsolAtaRent),
  };
  const settled = await Promise.allSettled(
    wallets.map((w) =>
      buyMigratedOne(connection, mint, poolKey, w, rent, slippagePct)
    )
  );
  return tally(settled);
}

/* ------------------------------------------------------------------ */
/* Migrated venue: the manual SELL on the graduated mint's pool        */
/* ------------------------------------------------------------------ */

/** The slippage band the manual Sell passes on the pool leg:
 *  POOL_SELL_SLIPPAGE_PCT (100 = a ZERO floor), which is also what Sell All's
 *  pool leg defaults to. Never a UI knob. The engine itself refuses anything
 *  above MAX_SLIPPAGE_PCT. */
export const MANUAL_POOL_SELL_SLIPPAGE_PCT: number = POOL_SELL_SLIPPAGE_PCT;

export interface SellMigratedSelectedOptions {
  connection: Connection;
  /** The graduated mint (it IS the PumpSwap pool's base mint). */
  mint: PublicKey;
  /** The canonical PumpSwap pool the mint migrated to (derive it with
   *  canonicalMigratedPoolPda, lib/migrate.ts). */
  poolKey: PublicKey;
  /** Selected keyed managed wallets to sell for. */
  wallets: AutoWallet[];
  /** % of each wallet's OWN balance to sell, in (0, 100]. */
  sellPct: number;
  /** Slippage band percent for the pool quote (default POOL_SELL_SLIPPAGE_PCT,
   *  100 = a ZERO floor). */
  slippagePct?: number;
}

/**
 * Sells sellPct% of every selected keyed wallet's own balance on the PumpSwap
 * pool (the graduated route: the curve is closed, so a curve sell reverts).
 *
 * This reuses Sell All's policy rather than re-implementing it: the same fold
 * plans each wallet's floor against the reserves its predecessors' sells leave
 * (a concurrent fan-out cannot trip floors that only held for the snapshot
 * state), every attempt re-quotes the live pool inside `sellOneWalletOnPool`,
 * and a slippage revert is retried on its own budget against that fresh quote.
 * Each wallet signs and pays for its own tx and the SDK closes its WSOL account
 * in the same tx, so the proceeds land as NATIVE SOL.
 *
 * The fold is planned for the SELECTED subset AND the SELECTED percentage: the
 * plan's step amounts are the amounts the legs send, so a stale 100% plan would
 * set floors a partial sell cannot meet. Skipped = zero balance (or a
 * percentage that floors to zero raw units); failed = a build/send/confirm
 * error that survived the retry budgets.
 */
export async function sellSelectedWalletsMigrated(
  opts: SellMigratedSelectedOptions
): Promise<ManualBatchResult> {
  const { connection, mint, poolKey, wallets, sellPct } = opts;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0, signatures: [] };
  }
  const slippagePct = opts.slippagePct ?? MANUAL_POOL_SELL_SLIPPAGE_PCT;
  // Guard rails FIRST, before any network call, the same way Sell All validates
  // its own: a manual round must not be able to widen slippage past the ceiling
  // or ask for a sell of nothing, and the caller has to see the real reason
  // rather than a per-wallet failure count.
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) {
    throw new Error(
      `sellPct ${sellPct} is outside the allowed range (0, 100] (a sell of nothing is a no-op, not a report)`
    );
  }
  if (
    !Number.isFinite(slippagePct) ||
    slippagePct < 0 ||
    slippagePct > MAX_SLIPPAGE_PCT
  ) {
    throw new Error(
      `slippagePct ${slippagePct} is outside the allowed range [0, ${MAX_SLIPPAGE_PCT}] ` +
        `(MAX_SLIPPAGE_PCT guard rail: refusing to widen slippage to force a fill)`
    );
  }
  // Pre-flight, once: a mint that reports graduated without a pool behind it
  // fails the run with one clean error instead of N wallet-side failures.
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  if (!poolInfo) {
    throw new Error(
      `PUMPSWAP POOL ${poolKey.toBase58()} NOT FOUND (NOT MIGRATED?)`
    );
  }
  // Folded floors over the SELECTED subset, the same plan Sell All builds.
  // Non-fatal by design (the sell-all rule): an empty plan means every wallet
  // quotes fresh inside its own leg, which is the pre-fold behaviour and is
  // only ever worse in that it may revert once and retry. A planning failure
  // (one transient RPC read) must never abort a sell that would otherwise land.
  let floors = new Map<string, bigint>();
  try {
    floors = await planFoldedFloors({
      connection,
      mint,
      wallets,
      route: "pumpSwap",
      poolKey,
      // Unused on the pool route: the fold reads the pool's own reserves.
      curveVirtualSolReserves: BigInt(0),
      curveVirtualTokenReserves: BigInt(0),
      slippagePct,
      sellPct,
    });
  } catch {
    floors = new Map<string, bigint>();
  }
  const settled = await Promise.allSettled(
    wallets.map(async (w) => {
      const kp = Keypair.fromSecretKey(bs58.decode(w.key));
      return await sellOneWalletOnPool({
        connection,
        mint,
        poolKey,
        wallet: kp,
        sellPct,
        slippagePct,
        minOutLamports: floors.get(w.address),
      });
    })
  );
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  const signatures: string[] = [];
  for (const r of settled) {
    if (r.status !== "fulfilled") {
      // A rejected worker (an unreadable key, say) is a failure for that
      // wallet, and the count stays visible.
      failed += 1;
      continue;
    }
    const outcome = r.value;
    if (outcome.status === "sold") {
      completed += 1;
      if (outcome.signature) signatures.push(outcome.signature);
    } else if (outcome.status === "skipped") {
      skipped += 1;
    } else {
      failed += 1;
    }
  }
  return { completed, failed, skipped, signatures };
}
