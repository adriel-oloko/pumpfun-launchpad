// Milestone M5: the auto buy/sell engine (Feature 2), now on pump.fun's
// NATIVE program (M10).
//
// Port of v4-launchpad's auto engine to the Solana client, with the exact
// agreed semantics:
//
//   - Auto BUY: on/off, wallet count, duration (seconds), MIN SOL. Each round
//     picks `count` RANDOM keyed wallets with a known SOL balance > 0 and
//     >= MIN SOL (below min = SKIP), and buys a % of the wallet's spendable
//     SOL balance (v4 default 95) from the curve via pump.fun's buy
//     instruction. The spendable base is the live balance minus the
//     rent-exempt floor, the tx fee margin, and (on a wallet's very first buy
//     of this mint) the legacy-SPL ATA rent, so a buy tx can never leave the
//     wallet below rent or fail for lack of ATA rent.
//   - Auto SELL: on/off, wallet count, duration, SELL %. Each round picks
//     `count` RANDOM keyed wallets with token balance > 0 and sells SELL %
//     of their OWN holdings (default 100) via pump.fun's sell instruction.
//     A wallet with no token balance is SKIPPED. The % input sets the sell
//     fraction of each wallet's OWN bag directly (there is no MIN % dust
//     gate against total supply). When a hub address is supplied, every
//     wallet whose sell CONFIRMS automatically sweeps that sale's SOL
//     proceeds (measured as the wallet's balance delta across the sell,
//     net of the sell fee) to the hub in a follow-up wallet-signed
//     transfer, so the proceeds never sit in the seller.
//   - Trade execution: each picked wallet's trade is its own signed tx (the
//     wallet is the fee payer), fired concurrently with Promise.allSettled,
//     reporting only the final completed count (the v4 batch pattern).
//
// M10 (native pump.fun):
//   - pump.fun's buy takes TOKENS OUT (+ max_sol_cost) and sell takes
//     TOKENS IN (+ min_sol_output), so every trade is quoted client-side
//     against the curve's VIRTUAL reserves (constant product + 1% fee +
//     slippage headroom). Quotes chain across the round's wallets so each
//     wallet quotes the state the preceding fills leave behind.
//   - Every instruction is built by hand (lib/pump.ts); the mint's ATAs are
//     Token-2022 (pump.fun mints are Token-2022 since `create_v2`, so the base
//     ATA is derived with TOKEN_2022_PROGRAM_ID). No anchor Program, no IDL,
//     no BN.
//
//   - GRADUATED mints: the curve is closed (every curve buy/sell reverts), so
//     the scheduler routes the round to the canonical PumpSwap pool instead
//     (autoVenueFor + fireAutoBuyPool / fireAutoSellPool). The venue is chosen
//     from the SAME curve read the scheduler already does; `complete` = 1 means
//     the pool. The bot never stops on graduation. The pool rounds trade at the
//     venue band (POOL_AUTO_SLIPPAGE_PCT = POOL_SLIPPAGE_PCT, 20), and the pool
//     BUY goes out EXACT-IN, so the band is a floor on the tokens received and
//     costs no spendable headroom (the commit is buyPct% of spendable, full
//     stop).
//
// The venue gate lives in the scheduler (components/trade-panel.tsx): before
// each round it fetches the curve state and derives the venue. This module
// exposes the state read and the pure venue seam so both the Start validation
// and each tick use the same path.
//
// Round serialization (one shared autoLockRef) lives in the trade panel, not
// here: this module's fire functions are pure per-round workers.
//
// All amounts are bigint (no bigint literals, project target is ES2017);
// every tx is signed manually with the wallet's Keypair (anchor Wallet is
// Node-only in the browser, and the anchor Program is gone entirely).

import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  RENT_EXEMPT_FLOOR,
  sendAndConfirmWithRetry,
  walletTokenBalance,
} from "./bundle/launch";
import type { SendTx } from "./bundle/protected-send";
import { WSOL_MINT, canonicalMigratedPoolPda } from "./migrate";
import { CURVE_SLIPPAGE_BPS } from "./params";
import {
  buildPumpBuyExactSolInIx,
  buildPumpBuyIx,
  buildPumpSellIx,
  quotePumpBuy,
  quotePumpBuyExactIn,
  quotePumpSell,
  readPumpCurveState,
  resolvePumpFeeRecipient,
  type PumpCurveState,
} from "./pump";
import { sellOneWalletOnPool } from "./sell-all";
import { buyMigratedPool, POOL_SLIPPAGE_PCT } from "./swap";

/** % of a wallet's spendable SOL balance bought per auto-buy round (v4's
 *  buyPct default). Configurable knob; no UI field exists for it in the AUTO
 *  tab (v4 kept it on its manual tab, which this launchpad omits by spec). */
export const AUTO_BUY_PCT: number = 95;

/** % of a wallet's OWN token holdings sold per auto-sell round (v4's
 *  sellPct default). */
export const AUTO_SELL_PCT: number = 100;

/** Max seconds a per-wallet tx may take to confirm before the round counts
 *  it as failed (devnet confirmations are usually < 2s; this is generous). */
export const AUTO_CONFIRM_TIMEOUT_MS: number = 40_000;

/** Lamports reserved above the rent floor on a buy (covers the 5000-lamport
 *  base fee and a small margin). */
export const AUTO_TX_FEE_RESERVE_LAMPORTS: bigint = BigInt(10_000);

/** Lamports a post-sell sweep leaves behind in the seller (on top of the
 *  wallet's pre-sell balance) to pay the sweep transfer's own ~5000-lamport
 *  fee. Mirrors WITHDRAW_FEE_RESERVE_LAMPORTS in lib/disperse.ts. */
export const AUTO_SWEEP_FEE_RESERVE_LAMPORTS: bigint = BigInt(10_000);

/** Slippage PERCENT (the PumpSwap SDK's 0-100 unit) the auto pool rounds pass:
 *  the venue band, POOL_SLIPPAGE_PCT (20), so the bot tolerates the same
 *  adverse move the manual Buy MAX / Sell do. On the buy it is a floor on the
 *  tokens received (the bot's pool buy is exact-in, lib/swap.ts), so it needs
 *  no wrap headroom out of the spendable base. */
export const POOL_AUTO_SLIPPAGE_PCT: number = POOL_SLIPPAGE_PCT;

/** A live roster balance for the picker. Matches the shape useRoster keeps. */
export interface AutoWalletBalance {
  /** Lamports; null when the last read failed (keep it out of picks). */
  sol: bigint | null;
  /** Raw token units for the tracked mint; null when unknown. */
  token: bigint | null;
}

/** A keyed roster wallet eligible for a round. */
export interface AutoWallet {
  address: string;
  /** Base58 64-byte secret. Only keyed wallets are ever picked. */
  key: string;
}

/** Decoded curve state for the auto engine's gates (pump.fun bonding curve;
 *  sol/token reserves are the VIRTUAL reserves the program quotes on). */
export interface AutoCurveInfo {
  /** Base58 creator pubkey; every curve buy/sell carries the creator_vault
   *  derived from it (the fee-program creator leg). */
  creator: string;
  /** True once the curve graduated (`complete` flag); the curve is closed and
   *  the round routes to the canonical PumpSwap pool instead. */
  graduated: boolean;
  solReserve: bigint;
  tokenReserve: bigint;
}

/** Fetch result that distinguishes "mint has no curve" from RPC errors. */
export type AutoCurveRead =
  | { kind: "ok"; curve: AutoCurveInfo }
  | { kind: "missing" };

/** Converts a parsed pump.fun curve state to the engine's AutoCurveInfo. */
export function toAutoCurveInfo(curve: PumpCurveState): AutoCurveInfo {
  return {
    creator: curve.creator.toBase58(),
    graduated: curve.complete,
    solReserve: curve.virtualSolReserves,
    tokenReserve: curve.virtualTokenReserves,
  };
}

/**
 * Fetches the pump.fun curve state for a mint (bonding-curve PDA under
 * pump.fun's program; the account layout is parsed in lib/pump.ts).
 * Returns { kind: "missing" } when the curve account does not exist or does
 * not decode (e.g. a random mint with no curve behind the token address);
 * throws on transport/RPC errors so the caller can retry instead of treating
 * a transient failure as a dead curve.
 */
export async function readAutoCurveState(
  connection: Connection,
  mint: PublicKey
): Promise<AutoCurveRead> {
  const read = await readPumpCurveState(connection, mint);
  if (read.kind === "missing") return { kind: "missing" };
  return { kind: "ok", curve: toAutoCurveInfo(read.curve) };
}

/* ------------------------------------------------------------------ */
/* Venue routing: bonding curve vs the canonical PumpSwap pool         */
/* ------------------------------------------------------------------ */

/** Which venue a round trades: the bonding curve, or the canonical PumpSwap
 *  pool the curve migrates to at graduation. Pure: the caller passes the curve
 *  it already read, so the route and the round cannot disagree. */
export type AutoVenue =
  | { kind: "curve" }
  | { kind: "pumpSwap"; poolKey: PublicKey };

/** The venue for a round, from the curve the scheduler already read: a
 *  graduated curve (`complete` = 1) means the canonical PumpSwap pool that
 *  replaced it; otherwise the curve. Pure (the pool PDA is derived, no RPC). */
export function autoVenueFor(mint: PublicKey, curve: AutoCurveInfo): AutoVenue {
  if (!curve.graduated) return { kind: "curve" };
  return { kind: "pumpSwap", poolKey: canonicalMigratedPoolPda(mint)[0] };
}

/** Pool MAX/spendable base for one wallet: the same rule the curve worker uses
 *  (live minus the rent floor, the tx fee reserve, and ONLY the accounts the
 *  buy tx must create: the Token-2022 base ATA and the WSOL account the SDK
 *  wraps into). Returns 0 when nothing is spendable. Pure. */
export function poolSpendableForBuy(opts: {
  liveLamports: bigint;
  baseAtaRentLamports: bigint; // 0 when the ATA exists
  wsolAtaRentLamports: bigint; // 0 when the WSOL ATA exists
}): bigint {
  const spendable =
    opts.liveLamports -
    BigInt(RENT_EXEMPT_FLOOR) -
    AUTO_TX_FEE_RESERVE_LAMPORTS -
    opts.baseAtaRentLamports -
    opts.wsolAtaRentLamports;
  return spendable > BigInt(0) ? spendable : BigInt(0);
}

/** The amount the pool buy commits: buyPct% of spendable (AUTO_BUY_PCT, 95).
 *  Pure. NO slippage cap since 2026-09-14: the pool buy goes out EXACT-IN
 *  (buy_exact_quote_in, lib/swap.ts), so the WSOL the tx wraps is the commit
 *  itself and the band is only a floor on the tokens received. (The old
 *  `capBuySolForSlippage` cap — since DELETED, no buy shape needs it anymore —
 *  existed because the SDK's plain `buy` wrapped `commit * (1 + s/100)`; it
 *  left ~9% of a full-spend round unspent.) */
export function poolBuyCommitLamports(
  spendableLamports: bigint,
  buyPct?: number
): bigint {
  if (spendableLamports <= BigInt(0)) return BigInt(0);
  const pctNum = Math.round((buyPct ?? AUTO_BUY_PCT) * 100);
  return (spendableLamports * BigInt(pctNum)) / BigInt(10_000);
}

/* ------------------------------------------------------------------ */
/* Input parsing (v4 clamps, ETH -> SOL)                              */
/* ------------------------------------------------------------------ */

/** Wallet count: blank/invalid -> 1 (v4's clamp). */
export function clampAutoCount(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Duration seconds -> ms: blank/invalid -> 2000ms (v4's clamp). */
export function clampAutoDurationMs(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n * 1000 : 2000;
}

/** MIN SOL input -> lamports; blank/invalid/zero -> 0n (no minimum). */
export function parseAutoMinSol(raw: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed) return BigInt(0);
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return BigInt(0);
  return BigInt(Math.round(n * LAMPORTS_PER_SOL));
}

/** SELL % input (0-100, blank/invalid/<=0 -> 100 = sell the whole bag). */
export function parseAutoSellPct(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return AUTO_SELL_PCT;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return AUTO_SELL_PCT;
  return Math.min(100, n);
}

/* ------------------------------------------------------------------ */
/* Balance-gated random picker (direction-aware, v4 semantics)        */
/* ------------------------------------------------------------------ */

/**
 * Randomly picks `count` keyed wallets that clear the side's balance gate:
 *   - 'sol'   (buy): known SOL balance > 0 and >= minSolLamports.
 *   - 'token' (sell): known token balance > 0.
 * Wallets with no known balance (read failed / never polled) are treated as
 * unfunded and skipped, exactly like v4. A fresh draw every tick. There is
 * NO hub wallet in this launchpad (every roster wallet is a dev wallet), so
 * unlike v4 no first row is excluded.
 */
export function pickRandomKeyedWallets(
  count: number,
  side: "sol" | "token",
  wallets: { address: string; key?: string }[],
  balances: Map<string, AutoWalletBalance>,
  minSolLamports: bigint
): AutoWallet[] {
  const pool: AutoWallet[] = [];
  for (const w of wallets) {
    if (!w.key) continue;
    const bal = balances.get(w.address);
    if (!bal) continue;
    if (side === "sol") {
      const sol = bal.sol;
      if (sol === null || sol <= BigInt(0)) continue;
      if (sol < minSolLamports) continue;
    } else {
      const tok = bal.token;
      if (tok === null || tok <= BigInt(0)) continue;
    }
    pool.push({ address: w.address, key: w.key });
  }
  const n = Math.min(count, pool.length);
  // Fisher-Yates shuffle, then take the first n.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/* ------------------------------------------------------------------ */
/* Instruction builders (hand-built pump.fun ixs, lib/pump.ts)         */
/* ------------------------------------------------------------------ */

export interface AutoBuyIxOptions {
  buyer: PublicKey;
  mint: PublicKey;
  /** The curve's recorded creator (public key). */
  creator: PublicKey;
  /** The LIVE protocol fee recipient (resolvePumpFeeRecipient); a stale
   *  value makes the pump.fun program revert with Custom 6000. */
  feeRecipient: PublicKey;
  solInLamports: bigint;
  /** The curve's VIRTUAL reserves at quote time (readAutoCurveState). */
  solReserve: bigint;
  tokenReserve: bigint;
  slippageBps?: bigint;
}

/**
 * One auto-buy instruction pair: buyer = the wallet, curve accounts resolved
 * from the mint, creator accounts from the curve state (the creator_vault
 * leg of pump.fun's fee program). The SOL amount is quoted client-side to
 * tokens_out + max_sol_cost (pump.fun's buy takes TOKENS OUT).
 */
export function buildAutoBuyIx(opts: AutoBuyIxOptions): TransactionInstruction[] {
  const {
    buyer,
    mint,
    creator,
    feeRecipient,
    solInLamports,
    solReserve,
    tokenReserve,
    slippageBps,
  } = opts;
  const quote = quotePumpBuy({
    solInLamports,
    virtualSolReserves: solReserve,
    virtualTokenReserves: tokenReserve,
    slippageBps,
  });
  return buildPumpBuyIx({
    mint,
    buyer,
    creator,
    feeRecipient,
    tokensOut: quote.tokensOut,
    maxSolCost: quote.maxSolCost,
  });
}

export interface AutoSellIxOptions {
  seller: PublicKey;
  mint: PublicKey;
  /** The curve's recorded creator (public key); feeds the creator_vault
   *  account of pump.fun's sell. */
  creator: PublicKey;
  /** The LIVE protocol fee recipient (resolvePumpFeeRecipient); a stale
   *  value makes the pump.fun program revert with Custom 6000. */
  feeRecipient: PublicKey;
  tokenIn: bigint;
  /** The curve's VIRTUAL reserves at quote time. */
  solReserve: bigint;
  tokenReserve: bigint;
  slippageBps?: bigint;
}

/**
 * One auto-sell instruction pair: seller = the wallet. The token amount is
 * handed over with a min_sol_output quoted client-side (pump.fun's sell
 * takes TOKENS IN + a SOL floor).
 */
export function buildAutoSellIx(opts: AutoSellIxOptions): TransactionInstruction[] {
  const {
    seller,
    mint,
    creator,
    feeRecipient,
    tokenIn,
    solReserve,
    tokenReserve,
    slippageBps,
  } = opts;
  const quote = quotePumpSell({
    tokensIn: tokenIn,
    virtualSolReserves: solReserve,
    virtualTokenReserves: tokenReserve,
    slippageBps,
  });
  return buildPumpSellIx({
    mint,
    seller,
    creator,
    feeRecipient,
    tokensIn: tokenIn,
    minSolOutput: quote.minSolOutput,
  });
}

/* ------------------------------------------------------------------ */
/* Round execution: per-wallet signed txs, concurrent, count only      */
/* ------------------------------------------------------------------ */

/** Per-round outcome: only the final counts (the v4 batch pattern). */
export interface AutoRoundResult {
  completed: number;
  failed: number;
  skipped: number;
  /** Number of completed sells whose proceeds were swept to the hub
   *  (auto-sell rounds with a hub address; buy rounds never set it). */
  swept?: number;
  /** Number of completed sells whose hub sweep FAILED: the sell landed but
   *  the proceeds stayed in the seller wallet (auto-sell with a hub
   *  address). The operator should run a manual Withdraw for those rows. */
  sweepFailed?: number;
}

export interface FireAutoBuyOptions {
  connection: Connection;
  mint: PublicKey;
  /** Curve state read at round start; quotes chain across the round. */
  curve: AutoCurveInfo;
  wallets: AutoWallet[];
  /** % of the wallet's spendable SOL balance to buy (default 95). */
  buyPct?: number;
  /** MIN SOL gate enforced again on the LIVE balance at fire time. */
  minSolLamports: bigint;
}

/**
 * Fires one auto-buy round: every picked wallet buys `buyPct`% of its own
 * spendable SOL balance as its own signed tx, concurrently. The spendable
 * base keeps the rent-exempt floor, a fee margin, and (first buy of this
 * mint only) the legacy-SPL ATA rent unspent, so the tx is always landable
 * on tiny devnet balances. Skipped = live balance under MIN SOL or nothing
 * tradeable; failed = build/send/confirm error. Completed = confirmed
 * on-chain.
 */
export async function fireAutoBuy(
  opts: FireAutoBuyOptions
): Promise<AutoRoundResult> {
  const { connection, mint, curve, wallets, minSolLamports } = opts;
  const buyPct = opts.buyPct ?? AUTO_BUY_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0 };
  }
  const pctNum = Math.round(buyPct * 100);
  const creator = new PublicKey(curve.creator);
  const ataRent = await connection.getMinimumBalanceForRentExemption(
    170,
    "confirmed"
  );
  const latest = await connection.getLatestBlockhash("confirmed");
  // Live protocol fee recipient (pump.fun rotates it; a stale value reverts
  // every buy with Custom 6000). One read for the whole round.
  const feeRecipient = await resolvePumpFeeRecipient(connection);
  // Normal raw-RPC send (sendAndConfirmWithRetry): buys send exactly like
  // sells, no Helius Sender / SWQOS tip / priority fee.
  const send = sendAndConfirmWithRetry;

  // Chain the round's quotes across the simulated reserves: wallet i quotes
  // the state wallets 0..i-1 leave behind (their fills land within the
  // round), so the quotes stay tight under the slippage band.
  let vsr = curve.solReserve;
  let vtr = curve.tokenReserve;

  const results = await Promise.allSettled(
    wallets.map(async (w): Promise<"ok" | "skipped"> => {
      const kp = Keypair.fromSecretKey(bs58.decode(w.key));
      const live = BigInt(
        await connection.getBalance(kp.publicKey, "confirmed")
      );
      // MIN SOL enforced on the live balance (a stale poll must not fire).
      if (live < minSolLamports) return "skipped";
      // Reserve the ATA rent only when the ATA account does not exist yet
      // (the wallet's first buy of this mint creates it on demand).
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
        reserveAta;
      if (spendable <= BigInt(0)) return "skipped";
      const solIn = (spendable * BigInt(pctNum)) / BigInt(10_000);
      // No slippage cap: the buy is EXACT-IN, so the program spends exactly
      // `solIn` and the band is a floor on the tokens received, not headroom
      // the wallet has to fund. (The old cap held the commit at spendable/1.10
      // for the plain buy's max_sol_cost headroom, which left ~9% unspent.)
      if (solIn <= BigInt(0)) return "skipped";
      const quote = quotePumpBuyExactIn({
        solInLamports: solIn,
        virtualSolReserves: vsr,
        virtualTokenReserves: vtr,
        slippageBps: CURVE_SLIPPAGE_BPS,
      });
      vsr = quote.nextVirtualSolReserves;
      vtr = quote.nextVirtualTokenReserves;
      const ixs = buildPumpBuyExactSolInIx({
        mint,
        buyer: kp.publicKey,
        creator,
        feeRecipient,
        spendableSolIn: solIn,
        minTokensOut: quote.minTokensOut,
      });
      const tx = new Transaction({
        feePayer: kp.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      tx.add(...ixs);
      // M7a: send + confirm with an automatic fresh-blockhash retry when the
      // blockhash expires (an expired tx can never land, so re-sending is
      // safe). Confirm timeouts surface as failures (the tx may still land),
      // they are never silently re-fired, which could double a buy.
      await send(connection, tx, [kp], {
        attempts: 2,
        confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
        label: "auto buy",
      });
      return "ok";
    })
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === "ok") completed += 1;
    else if (r.status === "fulfilled") skipped += 1;
    else failed += 1;
  }
  return { completed, failed, skipped };
}

/** The hub sweep shared by both sell legs: measures what the sale added
 *  (solAfter - solBefore), leaves AUTO_SWEEP_FEE_RESERVE_LAMPORTS behind for
 *  this transfer's own fee, and sends the rest to the hub. Returns "swept" on
 *  a confirmed transfer, "ok" when there is nothing to sweep, and
 *  "sweepFailed" when the transfer failed (the sale itself already landed; a
 *  sweep failure must never masquerade as a failed sell). */
export async function sweepProceedsToHub(opts: {
  connection: Connection;
  wallet: Keypair;
  hub: PublicKey;
  solBefore: bigint;
  send: SendTx;
}): Promise<"swept" | "ok" | "sweepFailed"> {
  const { connection, wallet, hub, solBefore, send } = opts;
  try {
    const solAfter = BigInt(
      await connection.getBalance(wallet.publicKey, "confirmed")
    );
    const proceeds = solAfter - solBefore;
    const amount = proceeds - AUTO_SWEEP_FEE_RESERVE_LAMPORTS;
    if (amount <= BigInt(0)) return "ok";
    const sweepTx = new Transaction({ feePayer: wallet.publicKey });
    sweepTx.add(
      SystemProgram.transfer({
        fromPubkey: wallet.publicKey,
        toPubkey: hub,
        lamports: Number(amount),
      })
    );
    await send(connection, sweepTx, [wallet], {
      attempts: 2,
      confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
      label: "auto sell sweep",
    });
    return "swept";
  } catch {
    return "sweepFailed";
  }
}

export interface FireAutoSellOptions {
  connection: Connection;
  mint: PublicKey;
  /** Curve state read at round start: the creator feeds the sell's
   *  creator_vault leg and the reserves feed the min_sol_output quote. */
  curve: AutoCurveInfo;
  wallets: AutoWallet[];
  /** % of each wallet's OWN holdings to sell (default 100). */
  sellPct?: number;
  /** Base58 address of the hub wallet (the FIRST roster wallet). When set,
   *  every wallet whose sell CONFIRMS immediately sweeps that sale's SOL
   *  proceeds to the hub in a follow-up wallet-signed transfer (the wallet
   *  keeps its pre-sale balance and a small fee reserve, so it stays open
   *  and rent-exempt). When unset the engine behaves exactly as before:
   *  proceeds stay in the seller. */
  hub?: string;
}

/**
 * Fires one auto-sell round: every picked wallet sells `sellPct`% of its OWN
 * token holdings as its own signed tx, concurrently. Skipped = live token
 * balance <= 0; failed = build/send/confirm error. When `hub` is set, each
 * wallet whose sell confirms also sends the sale's proceeds (measured as its
 * SOL balance delta across the sell) to the hub; a failed sweep after a
 * confirmed sell is reported via `sweepFailed` (the sale still counts as
 * completed, its proceeds just stayed in the seller).
 */
export async function fireAutoSell(
  opts: FireAutoSellOptions
): Promise<AutoRoundResult> {
  const { connection, mint, curve, wallets } = opts;
  const sellPct = opts.sellPct ?? AUTO_SELL_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0, swept: 0, sweepFailed: 0 };
  }
  const pctNum = Math.round(sellPct * 100);
  const creator = new PublicKey(curve.creator);
  // The hub sweep destination: parse once for the round; an unparseable
  // address disables the sweep (the sells themselves still run).
  let hubPk: PublicKey | null = null;
  if (opts.hub) {
    try {
      hubPk = new PublicKey(opts.hub);
    } catch {
      hubPk = null;
    }
  }
  const latest = await connection.getLatestBlockhash("confirmed");
  // Live protocol fee recipient (pump.fun rotates it; a stale value reverts
  // every sell with Custom 6000). One read for the whole round.
  const feeRecipient = await resolvePumpFeeRecipient(connection);
  // Plain raw-RPC send (sendAndConfirmWithRetry): sells are NORMAL txs, never
  // routed through Helius Sender SWQOS (its tip + priority fee would exceed a
  // seller wallet's SOL headroom and reject the tx before it lands).
  const send = sendAndConfirmWithRetry;

  // Chain the round's min_sol_output quotes across the simulated reserves.
  let vsr = curve.solReserve;
  let vtr = curve.tokenReserve;

  const results = await Promise.allSettled(
    wallets.map(
      async (w): Promise<"ok" | "skipped" | "swept" | "sweepFailed"> => {
        const kp = Keypair.fromSecretKey(bs58.decode(w.key));
        // Per-worker const so TS narrows past the null checks below.
        const hubDest = hubPk;
        const balance = await walletTokenBalance(
          connection,
          kp.publicKey,
          mint
        );
        if (balance <= BigInt(0)) return "skipped";
        const tokenIn = (balance * BigInt(pctNum)) / BigInt(10_000);
        if (tokenIn <= BigInt(0)) return "skipped";
        // Pre-sale SOL balance: only read when a hub sweep is armed and the
        // seller is not the hub itself (the proceeds are measured as the
        // wallet's balance delta across the sell, net of the sell's own
        // fee).
        const sweep = hubDest !== null && !hubDest.equals(kp.publicKey);
        const solBefore = sweep
          ? BigInt(await connection.getBalance(kp.publicKey, "confirmed"))
          : null;
        const quote = quotePumpSell({
          tokensIn: tokenIn,
          virtualSolReserves: vsr,
          virtualTokenReserves: vtr,
          // The operator's band (20%): min_sol_output sits this far under the
          // net quote, so a fill that collapsed past it reverts instead of
          // dumping the bag. A sell band is a floor, never headroom.
          slippageBps: CURVE_SLIPPAGE_BPS,
        });
        vsr = vsr + quote.netSolOut;
        vtr = vtr - tokenIn;
        const ixs = buildPumpSellIx({
          mint,
          seller: kp.publicKey,
          creator,
          feeRecipient,
          tokensIn: tokenIn,
          minSolOutput: quote.minSolOutput,
        });
        const tx = new Transaction({
          feePayer: kp.publicKey,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
        });
        tx.add(...ixs);
        // M7a: expiry-safe send + confirm, same semantics as the buy worker.
        await send(connection, tx, [kp], {
          attempts: 2,
          confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
          label: "auto sell",
        });
        // The sale landed. Now sweep its proceeds to the hub (only what the
        // sale added: solAfter - solBefore, leaving a fee reserve behind for
        // this sweep's own transfer fee so the wallet keeps its pre-sale
        // balance and stays rent-exempt). A failed sweep must not masquerade
        // as a failed sell (which the engine never re-fires), so it is
        // reported separately for a manual Withdraw of that row.
        if (hubDest === null || solBefore === null) return "ok";
        if (hubDest.equals(kp.publicKey)) return "ok";
        return sweepProceedsToHub({
          connection,
          wallet: kp,
          hub: hubDest,
          solBefore,
          send,
        });
      }
    )
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let swept = 0;
  let sweepFailed = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value === "skipped") skipped += 1;
      else if (r.value === "swept") {
        completed += 1;
        swept += 1;
      } else if (r.value === "sweepFailed") {
        completed += 1;
        sweepFailed += 1;
      } else {
        completed += 1;
      }
    } else {
      failed += 1;
    }
  }
  return { completed, failed, skipped, swept, sweepFailed };
}

/* ------------------------------------------------------------------ */
/* Round execution on the migrated PumpSwap venue                      */
/* ------------------------------------------------------------------ */

export interface FireAutoBuyPoolOptions {
  connection: Connection;
  mint: PublicKey;
  poolKey: PublicKey;
  wallets: AutoWallet[];
  /** % of the wallet's spendable SOL balance to buy (default 95). */
  buyPct?: number;
  /** MIN SOL gate enforced again on the LIVE balance at fire time. */
  minSolLamports: bigint;
}

/**
 * Fires one auto-buy round on the migrated PumpSwap pool: every picked wallet
 * buys `buyPct`% of its own pool-spendable SOL as its own signed tx,
 * concurrently. The spendable base keeps the rent-exempt floor, the fee
 * margin, and ONLY the rents the buy tx must actually create (the Token-2022
 * base ATA and the WSOL account the SDK wraps into), so the tx is always
 * landable. Skipped = live balance under MIN SOL, no spendable base, or a
 * commit that floors to zero; failed = a build/send/confirm error. Completed =
 * confirmed on-chain. Buy rounds never sweep.
 */
export async function fireAutoBuyPool(
  opts: FireAutoBuyPoolOptions
): Promise<AutoRoundResult> {
  const { connection, mint, poolKey, wallets, minSolLamports } = opts;
  const buyPct = opts.buyPct ?? AUTO_BUY_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0 };
  }
  // Rents of the two accounts the buy tx creates when missing: the Token-2022
  // base ATA (170 bytes) and the WSOL account (165 bytes; the SDK creates and
  // closes it inside the same tx, so its rent comes back). Read once per round
  // from the live Rent sysvar, exactly like the curve worker's ataRent.
  const [baseAtaRent, wsolAtaRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(170, "confirmed"),
    connection.getMinimumBalanceForRentExemption(165, "confirmed"),
  ]);
  const results = await Promise.allSettled(
    wallets.map(async (w): Promise<"ok" | "skipped"> => {
      const kp = Keypair.fromSecretKey(bs58.decode(w.key));
      const live = BigInt(
        await connection.getBalance(kp.publicKey, "confirmed")
      );
      // MIN SOL enforced on the live balance (a stale poll must not fire).
      if (live < minSolLamports) return "skipped";
      // Reserve each missing ATA's rent (the base ATA is created on demand;
      // the WSOL account is created + closed by the SDK inside the buy tx).
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
      const spendable = poolSpendableForBuy({
        liveLamports: live,
        baseAtaRentLamports: baseInfo ? BigInt(0) : BigInt(baseAtaRent),
        wsolAtaRentLamports: wsolInfo ? BigInt(0) : BigInt(wsolAtaRent),
      });
      const commit = poolBuyCommitLamports(spendable, buyPct);
      if (commit <= BigInt(0)) return "skipped";
      await buyMigratedPool({
        connection,
        poolKey,
        buyer: kp,
        quoteLamports: commit,
        slippagePct: POOL_AUTO_SLIPPAGE_PCT,
      });
      return "ok";
    })
  );
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === "ok") completed += 1;
    else if (r.status === "fulfilled") skipped += 1;
    else failed += 1;
  }
  return { completed, failed, skipped };
}

export interface FireAutoSellPoolOptions {
  connection: Connection;
  mint: PublicKey;
  poolKey: PublicKey;
  wallets: AutoWallet[];
  /** % of each wallet's OWN holdings to sell (default 100). */
  sellPct?: number;
  /** Base58 address of the hub wallet (the FIRST roster wallet). When set,
   *  every wallet whose sell CONFIRMS sweeps the sale's SOL proceeds to it in
   *  a follow-up wallet-signed transfer. When unset the proceeds stay in the
   *  seller. */
  hub?: string;
}

/**
 * Fires one auto-sell round on the migrated PumpSwap pool: every picked wallet
 * sells `sellPct`% of its OWN live balance through Sell All's per-wallet pool
 * leg (sellOneWalletOnPool), concurrently. That leg re-quotes the live pool
 * per attempt and owns the retry policy, so this worker adds no folded floors:
 * the round is small and the next round retries. Skipped = zero/unreadable
 * balance or a % that floors to zero; failed = a build/send/confirm error that
 * survived the leg's budgets. When `hub` is set, a confirmed sell's proceeds
 * are swept with sweepProceedsToHub; a sweep failure is reported via
 * `sweepFailed`, never as a failed sell.
 */
export async function fireAutoSellPool(
  opts: FireAutoSellPoolOptions
): Promise<AutoRoundResult> {
  const { connection, mint, poolKey, wallets } = opts;
  const sellPct = opts.sellPct ?? AUTO_SELL_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0, swept: 0, sweepFailed: 0 };
  }
  // Guard rail BEFORE any network call (a sell of nothing is a no-op, not a
  // report): the scheduler can never arm a zero/absurd pct round.
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) {
    throw new Error(
      `sellPct ${sellPct} is outside the allowed range (0, 100] (a sell of nothing is a no-op, not a report)`
    );
  }
  // Pre-flight the pool once: a mint that reports graduated without a pool
  // behind it fails with ONE clean error instead of N wallet-side failures.
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  if (!poolInfo) {
    throw new Error(
      `PUMPSWAP POOL ${poolKey.toBase58()} NOT FOUND (NOT MIGRATED?)`
    );
  }
  // The hub sweep destination: parse once for the round; an unparseable
  // address disables the sweep (the sells themselves still run).
  let hubPk: PublicKey | null = null;
  if (opts.hub) {
    try {
      hubPk = new PublicKey(opts.hub);
    } catch {
      hubPk = null;
    }
  }
  // Plain raw-RPC send (sendAndConfirmWithRetry), same as the curve leg.
  const send = sendAndConfirmWithRetry;
  const results = await Promise.allSettled(
    wallets.map(
      async (
        w
      ): Promise<"ok" | "skipped" | "failed" | "swept" | "sweepFailed"> => {
        const kp = Keypair.fromSecretKey(bs58.decode(w.key));
        // Per-worker const so TS narrows past the null checks below.
        const hubDest = hubPk;
        const sweep = hubDest !== null && !hubDest.equals(kp.publicKey);
        // Pre-sale balance, only when a hub sweep is armed and the seller is
        // not the hub itself (the proceeds are the wallet's balance delta
        // across the sell).
        const solBefore = sweep
          ? BigInt(await connection.getBalance(kp.publicKey, "confirmed"))
          : null;
        const outcome = await sellOneWalletOnPool({
          connection,
          mint,
          poolKey,
          wallet: kp,
          sellPct,
          slippagePct: POOL_AUTO_SLIPPAGE_PCT,
        });
        if (outcome.status === "skipped") return "skipped";
        if (outcome.status === "failed") return "failed";
        if (hubDest === null || solBefore === null) return "ok";
        return sweepProceedsToHub({
          connection,
          wallet: kp,
          hub: hubDest,
          solBefore,
          send,
        });
      }
    )
  );
  let completed = 0;
  let failed = 0;
  let skipped = 0;
  let swept = 0;
  let sweepFailed = 0;
  for (const r of results) {
    if (r.status !== "fulfilled") {
      failed += 1;
      continue;
    }
    if (r.value === "skipped") skipped += 1;
    else if (r.value === "failed") failed += 1;
    else if (r.value === "swept") {
      completed += 1;
      swept += 1;
    } else if (r.value === "sweepFailed") {
      completed += 1;
      sweepFailed += 1;
    } else {
      completed += 1;
    }
  }
  return { completed, failed, skipped, swept, sweepFailed };
}
