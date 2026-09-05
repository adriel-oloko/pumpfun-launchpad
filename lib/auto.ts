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
//   - Auto SELL: on/off, wallet count, duration, MIN %. Each round picks
//     `count` RANDOM keyed wallets with token balance > 0 and sells a % of
//     their OWN holdings (v4 default 100) via pump.fun's sell instruction.
//     MIN % is a per-wallet dust gate measured against the token's TOTAL
//     SUPPLY: a wallet holding below (MIN % of total supply) is SKIPPED, so
//     the bot never burns rounds/txs dumping dust. MIN % = 0 or blank
//     disables the gate (v4 behavior: sell any wallet with a bag).
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
//     LEGACY SPL (pump.fun mints are not Token-2022). No anchor Program, no
//     IDL, no BN.
//
// The graduation guard lives in the scheduler (components/trade-panel.tsx):
// before each round it fetches the curve state and stops the bot when
// `graduated` is true. This module exposes the state read so both the Start
// validation and each tick use the same path.
//
// Round serialization (one shared autoLockRef) lives in the trade panel, not
// here: this module's fire functions are pure per-round workers.
//
// All amounts are bigint (no bigint literals, project target is ES2017);
// every tx is signed manually with the wallet's Keypair (anchor Wallet is
// Node-only in the browser, and the anchor Program is gone entirely).

import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  RENT_EXEMPT_FLOOR,
  sendAndConfirmWithRetry,
  walletTokenBalance,
} from "./bundle/launch";
import {
  buildPumpBuyIx,
  buildPumpSellIx,
  quotePumpBuy,
  quotePumpSell,
  readPumpCurveState,
  resolvePumpFeeRecipient,
  type PumpCurveState,
} from "./pump";
import { TOTAL_SUPPLY } from "./params";

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
  /** Base58 creator pubkey; every buy/sell carries the creator_vault
   *  derived from it (the fee-program creator leg). */
  creator: string;
  /** True once the curve graduated (`complete` flag); buy/sell revert and
   *  the bot stops. */
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

/** MIN % input (0-100, blank/invalid/<=0 -> 0 = gate disabled). */
export function parseAutoMinPct(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

/** Raw token floor for the sell MIN % gate: MIN % of TOTAL_SUPPLY. A wallet
 *  holding below this is dust and is skipped. 0 when the gate is disabled. */
export function autoSellMinRaw(pct: number): bigint {
  if (!(pct > 0)) return BigInt(0);
  return (TOTAL_SUPPLY * BigInt(Math.round(pct * 100))) / BigInt(10_000);
}

/* ------------------------------------------------------------------ */
/* Balance-gated random picker (direction-aware, v4 semantics)        */
/* ------------------------------------------------------------------ */

/**
 * Randomly picks `count` keyed wallets that clear the side's balance gate:
 *   - 'sol'   (buy): known SOL balance > 0 and >= minSolLamports.
 *   - 'token' (sell): known token balance > 0 and >= minSellRaw (MIN % gate;
 *             minSellRaw = 0 disables it).
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
  minSolLamports: bigint,
  minSellRaw: bigint
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
      if (tok < minSellRaw) continue;
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
    165,
    "confirmed"
  );
  const latest = await connection.getLatestBlockhash("confirmed");
  // Live protocol fee recipient (pump.fun rotates it; a stale value reverts
  // every buy with Custom 6000). One read for the whole round.
  const feeRecipient = await resolvePumpFeeRecipient(connection);

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
      if (solIn <= BigInt(0)) return "skipped";
      const quote = quotePumpBuy({
        solInLamports: solIn,
        virtualSolReserves: vsr,
        virtualTokenReserves: vtr,
      });
      vsr = quote.nextVirtualSolReserves;
      vtr = quote.nextVirtualTokenReserves;
      const ixs = buildPumpBuyIx({
        mint,
        buyer: kp.publicKey,
        creator,
        feeRecipient,
        tokensOut: quote.tokensOut,
        maxSolCost: quote.maxSolCost,
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
      await sendAndConfirmWithRetry(connection, tx, [kp], {
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

export interface FireAutoSellOptions {
  connection: Connection;
  mint: PublicKey;
  /** Curve state read at round start: the creator feeds the sell's
   *  creator_vault leg and the reserves feed the min_sol_output quote. */
  curve: AutoCurveInfo;
  wallets: AutoWallet[];
  /** % of each wallet's OWN holdings to sell (default 100). */
  sellPct?: number;
  /** MIN % dust gate (raw floor = pct of TOTAL_SUPPLY), re-checked on the
   *  live balance at fire time; 0 disables. */
  minSellRaw: bigint;
}

/**
 * Fires one auto-sell round: every picked wallet sells `sellPct`% of its OWN
 * token holdings as its own signed tx, concurrently. Skipped = live token
 * balance <= 0 or below the MIN % floor; failed = build/send/confirm error.
 */
export async function fireAutoSell(
  opts: FireAutoSellOptions
): Promise<AutoRoundResult> {
  const { connection, mint, curve, wallets, minSellRaw } = opts;
  const sellPct = opts.sellPct ?? AUTO_SELL_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0 };
  }
  const pctNum = Math.round(sellPct * 100);
  const creator = new PublicKey(curve.creator);
  const latest = await connection.getLatestBlockhash("confirmed");
  // Live protocol fee recipient (pump.fun rotates it; a stale value reverts
  // every sell with Custom 6000). One read for the whole round.
  const feeRecipient = await resolvePumpFeeRecipient(connection);

  // Chain the round's min_sol_output quotes across the simulated reserves.
  let vsr = curve.solReserve;
  let vtr = curve.tokenReserve;

  const results = await Promise.allSettled(
    wallets.map(async (w): Promise<"ok" | "skipped"> => {
      const kp = Keypair.fromSecretKey(bs58.decode(w.key));
      const balance = await walletTokenBalance(
        connection,
        kp.publicKey,
        mint
      );
      if (balance <= BigInt(0)) return "skipped";
      if (balance < minSellRaw) return "skipped";
      const tokenIn = (balance * BigInt(pctNum)) / BigInt(10_000);
      if (tokenIn <= BigInt(0)) return "skipped";
      const quote = quotePumpSell({
        tokensIn: tokenIn,
        virtualSolReserves: vsr,
        virtualTokenReserves: vtr,
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
      await sendAndConfirmWithRetry(connection, tx, [kp], {
        attempts: 2,
        confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
        label: "auto sell",
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
