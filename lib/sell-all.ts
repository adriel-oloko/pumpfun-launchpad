// Milestone M6: the SELL ALL engine, on pump.fun's NATIVE program (M10).
//
// One call sells every managed wallet's full token balance of a mint,
// routed by the on-chain curve state (the key part):
//
//   - NOT GRADUATED (`complete` = 0): the curve is still open, so each
//     wallet sells through pump.fun's sell(tokens_in, min_sol_output)
//     instruction (100% of its token balance, quoted client-side against
//     the VIRTUAL reserves with a slippage floor).
//   - GRADUATED (`complete` = 1): the curve is closed (sell reverts; pump.fun
//     auto-migrated it to PumpSwap at graduation — the client never calls a
//     migrate instruction anymore); each wallet instead swaps its full
//     balance to WSOL on the PumpSwap pool via the official
//     @pump-fun/pump-swap-sdk (sellBaseInput quotes a fresh minAmountOut
//     from the pool reserves under the slippage band). The SDK's sell
//     instruction stream closes the WSOL account in the same transaction
//     (quote mint = native mint), so each wallet ends up with native SOL,
//     no leftover WSOL ATA.
//
// Wallets without a key (watch-only) or with a zero token balance are
// skipped. The per-wallet sells run CONCURRENTLY (Promise.allSettled, the
// v4 multi-wallet batch pattern) and the caller is handed the final
// completed count plus a per-wallet report (route, signature, SOL
// received) and the holder count measured after the run.
//
// Browser-safe: this module only builds/signs with Keypairs and reads the
// chain through the passed Connection; it never imports the anchor Wallet
// class or the anchor Program (M10: the curve sell is a hand-built
// lib/pump.ts instruction over the TOKEN-2022 token program — every token
// pump.fun's active create_v2 path mints is Token-2022).

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { AddressLookupTableState } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import bs58 from "bs58";
import { MAX_TX_BYTES, holderCount, walletTokenBalance } from "./bundle/launch";
import { ensurePumpLookupTable, pumpLookupAccounts } from "./bundle/lookup";
import {
  buildPumpSellIx,
  quotePumpSell,
  readPumpCurveState,
  resolvePumpFeeRecipient,
} from "./pump";
import {
  CANONICAL_POOL_INDEX,
  failedSignatureOf,
  lookupMigratedPool,
  sendRawWithRetry,
} from "./migrate";
import {
  POOL_SELL_SLIPPAGE_PCT,
  poolPercentFloor,
  sellMigratedPool,
} from "./swap";
import { friendlyTxError, isSlippageRevert } from "./tx-errors";
import { OnlinePumpAmmSdk, PUMP_AMM_PROGRAM_ID, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { foldCurveSells, foldPoolSells, type SellSequenceStep } from "./sell-fold";
import { submitBundleViaFanoutWithRetry } from "./bundle/fanout-submit";
import type { BundleAttempt, BundleSubmissionResult } from "./bundle/jito";
import {
  defaultTipAccountForRelay,
  RELAY_MIN_TIP_LAMPORTS,
  RELAY_ORDER,
  submitBundleViaRelayProxy,
  summarizeFanout,
  type RelayId,
} from "./bundle/relays";
import { DEFAULT_JITO_TIP_LAMPORTS } from "./fees";
import { solanaNetwork } from "./network";

/** A managed roster wallet the engine can sell for (key optional: wallets
 *  without a base58 secret are skipped, watch-only rows never sign). */
export interface SellableWallet {
  address: string;
  key?: string;
}

export type SellRoute = "curve" | "pumpSwap";

/** R3 guard rail (exported): the hard ceiling on `slippagePct`. A value above
 *  this is REJECTED outright, never clamped.
 *
 *  RAISED TO 100 on 2026-09-14 at the operator's direction: the sell band is
 *  now 100% (a ZERO floor), so an exit can never be refused on price. The
 *  rail's job is therefore only to keep the number SANE (finite, >= 0, <= 100):
 *  100 is a legal, chosen value, and it is the only one that removes the
 *  protection entirely. The old 25 ceiling was there to stop a wider band
 *  being used as a workaround for a race; the operator has explicitly taken
 *  that trade-off on the SELL side. The BUY side stays at 20 (see
 *  POOL_BUY_SLIPPAGE_PCT in lib/swap.ts and CURVE_BUY_SLIPPAGE_BPS in
 *  lib/params.ts), where the band is a floor on the tokens received and there
 *  is no reason to give it up. */
export const MAX_SLIPPAGE_PCT = 100;

/** The share of a wallet's own balance one sell takes, in raw token units,
 *  FLOORED: a partial sell cannot take more than the wallet holds, and it
 *  takes the lower whole raw unit. 100 (or above) sells the whole bag EXACTLY,
 *  so the full-balance default stays byte-identical to the behaviour sell-all
 *  has always had. 0 / blank / non-finite yields 0, which the callers report
 *  as SKIPPED (there is nothing to sell). Exported so the offline suite pins
 *  it. */
export function pctTokens(tokens: bigint, pct: number): bigint {
  const n = Number(pct);
  if (!Number.isFinite(n) || n <= 0) return BigInt(0);
  if (n >= 100) return tokens;
  const pctNum = BigInt(Math.round(n * 100));
  return (tokens * pctNum) / BigInt(10_000);
}

/** R2: reads the live curve to (re-)quote ONE attempt. The curve leg must call
 *  this on every attempt and never reuse a run-level snapshot — a retry against
 *  stale reserves would just burn the attempt budget on a price that cannot
 *  change. The run-level read only chooses the route and derives
 *  creator/poolKey. */
export type CurveReader = () => Promise<
  | {
      ok: true;
      creator: PublicKey;
      virtualSolReserves: bigint;
      virtualTokenReserves: bigint;
    }
  | { ok: false; reason: string }
>;

export interface SellOutcome {
  address: string;
  /** The venue actually used for this wallet's sell. */
  route: SellRoute;
  status: "sold" | "skipped" | "failed";
  /** Skip/failure reason (short, human label). */
  reason?: string;
  /** Raw token units sold (0 when skipped/failed). */
  tokenSold: bigint;
  /** Native SOL lamports received, measured as the wallet's SOL balance
   *  delta across the sell (nets the ~5000-lamport tx fee; 0 when
   *  skipped/failed). */
  solReceivedLamports: bigint;
  /** Confirmed transaction signature (only when sold). */
  signature?: string;
  /** R4: total send attempts made for this wallet (1 = first try landed). */
  attempts?: number;
  /** R4: true when the sell only landed after at least one slippage re-quote. */
  retriedOnSlippage?: boolean;
  /** R4: confirmed signature of a FAILED attempt, when one exists, so the
   *  revert is inspectable instead of lost (the gap that made the section 2.1
   *  failures require an on-chain scavenger hunt). */
  lastFailedSignature?: string;
}

export interface SellAllOptions {
  connection: Connection;
  /** The token mint to sell (curve mint = PumpSwap base mint). */
  mint: PublicKey;
  /** The managed roster; keyed wallets are sold, watch-only skipped. */
  wallets: SellableWallet[];
  /** Slippage percent for the quotes (default POOL_SELL_SLIPPAGE_PCT, 100 = a
   *  ZERO floor), applied to the curve leg's min_sol_output AND passed to the
   *  PumpSwap SDK's sell leg. Values above MAX_SLIPPAGE_PCT are rejected
   *  outright rather than clamped. */
  slippagePct?: number;
  /** Share of each wallet's OWN balance to sell, percent in (0, 100]. Default
   *  100 = the whole bag (the sell-all contract). A partial sell is sized from
   *  the wallet's live balance and planned through the SAME fold, so the
   *  folded floors match the amounts actually sold. Values outside (0, 100]
   *  are rejected: a sell of nothing is a no-op, not a report. */
  sellPct?: number;
  /** STAGE 2: plan the whole sell sequence with FOLDED FLOORS (default true).
   *  Each wallet's floor then reflects the reserves its PREDECESSORS' sells
   *  leave, so a concurrent fan-out cannot trip floors that only held for the
   *  snapshot state. Ignored when fewer than two keyed wallets can sell (there
   *  is nothing to race), and each wallet still takes the LOWER of its folded
   *  floor and its own fresh quote, so this can only ever loosen a floor. */
  foldedFloors?: boolean;
  /** Max wallets selling at once. Default 3. 1 = strictly sequential (each
   *  wallet quotes after the previous one landed). Values above
   *  wallets.length are clamped. */
  concurrency?: number;
  /** PumpSwap pool index seed (default CANONICAL_POOL_INDEX = 0). */
  poolIndex?: number;
  /** STAGE 2B: how the sells are submitted.
   *   - "perWallet" (default): one tx per wallet through the v4 bounded
   *     fan-out, exactly today's behaviour.
   *   - "bundle": ONE atomic relay bundle, assembled in FOLD order.
   *     MAINNET ONLY: every relay in lib/bundle/relays.ts is a mainnet service.
   *     A non-landing bundle is reported as ONE run-level failure and never
   *     falls back to per-wallet sends. */
  submit?: "perWallet" | "bundle";
  /** STAGE 2B bundle mode: the wallet that pays the relay tip (the assembler
   *  appends the tip transfer to the LAST bundle tx). Defaults to the FIRST
   *  wallet in FOLD order. */
  tipPayer?: Keypair;
  /** STAGE 3 bundle mode: a previously created sell ALT to reuse. When
   *  omitted a table is created (through `ensurePumpLookupTable`) and extended
   *  with the sell-shared pool/mint/ATA keys. Pool route only. */
  lookupTableAddress?: string | null;
}

export interface SellAllReport {
  route: SellRoute;
  /** Curve `complete` flag that chose the route. */
  graduated: boolean;
  /** The curve creator (the PumpSwap pool creator once graduated). */
  creator: string;
  /** Derived PumpSwap pool (only meaningful once graduated). */
  poolKey: string | null;
  /** Managed wallets considered. */
  total: number;
  /** Wallets skipped (no key / zero balance). */
  skipped: number;
  /** Wallets that failed (their sells were attempted). */
  failed: number;
  /** FINAL COMPLETED COUNT (the only headline number; v4 batch pattern). */
  sold: number;
  outcomes: SellOutcome[];
  /** Holder count after the run (null when the RPC read failed). */
  holderCountAfter: number | null;
  /** STAGE 2B: which submit path produced this report. */
  submit?: "perWallet" | "bundle";
  /** STAGE 2B bundle runs: the winning/last-attempted relay (null when
   *  nothing accepted), the relay bundle id, the number of submission
   *  attempts (1 = landed first try) and the submitter's honest one-line
   *  note. Absent on per-wallet runs. */
  bundleRelay?: string | null;
  bundleId?: string | null;
  bundleAttempts?: number;
  bundleNote?: string | null;
}

/** True when a failure is a transient RPC/pool condition worth retrying
 *  (rate limits, endpoint backoff, transport errors, timeouts). On-chain
 *  reverts and user/balance errors are NOT transient. */
function isTransientRpcError(msg: string): boolean {
  return /pool exhausted|rate ?limit|429|408|503|502|failed to fetch|network error|socket|timed? ?out|timeout|econnreset|econnrefused|etimedout|fetch failed|blockhash not found/i.test(
    msg
  );
}

/** R1: classifies a per-wallet sell failure into the retry policy that must
 *  run.
 *   - "slippage":  the price moved past the floor; re-quote and retry
 *   - "transient": RPC/transport blip; paced retry
 *   - "permanent": stop
 *
 *  ORDER IS LOAD-BEARING: `isSlippageRevert` MUST come before any
 *  `isOnChainRevert` check, because an ExceededSlippage / TooLittleSolReceived
 *  revert also matches `custom program error` / `instructionerror` and would
 *  otherwise be misread as a permanent revert — exactly the bug where the
 *  re-quote never happened (spec assertion 5). */
export type SellErrorClass = "slippage" | "transient" | "permanent";

export function classifySellError(msg: string): SellErrorClass {
  if (isSlippageRevert(msg)) return "slippage";
  if (isTransientRpcError(msg)) return "transient";
  return "permanent";
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Per-wallet sell attempts: a wallet keeps retrying transient RPC failures
 *  (public devnet rate-limits bursts; the pool cools down for 45s after one
 *  429) with a growing gap, re-reading the balance before every attempt so a
 *  tx that actually landed despite a lost confirm is detected (balance 0 on
 *  a later attempt = the tokens already sold). */
const SELL_ATTEMPTS = 4;
const SELL_RETRY_BASE_MS = 8_000;

/** R2: slippage reverts get their OWN attempt budget, separate from
 *  SELL_ATTEMPTS. Every retry is a genuine re-quote, so the budget is real
 *  progress rather than a spin. 6 covers a fully concurrent 5-wallet dump in
 *  which each round lets one seller win (worst case the last wallet needs 5
 *  sends). */
const SLIPPAGE_ATTEMPTS = 6;

/** R2: the slippage remedy is the RE-QUOTE, not the wait, so this backoff is
 *  an order of one slot (short + jittered), not the RPC class's 8s/attempt. */
const SLIPPAGE_RETRY_BASE_MS = 750;
const SLIPPAGE_RETRY_CAP_MS = 4_000;

/** R3: default max wallets selling at once. The old unbounded fan-out is what
 *  produced the devnet failures; a bounded default plus R1/R2 is the resting
 *  state. */
export const DEFAULT_SELL_CONCURRENCY = 3;

function slippageBackoffMs(retry: number): number {
  const base = Math.min(SLIPPAGE_RETRY_CAP_MS, SLIPPAGE_RETRY_BASE_MS * retry);
  return base + Math.floor(Math.random() * 250);
}

/** R3: runs `tasks` with at most `concurrency` in flight, preserving input
 *  order and per-task error isolation (the Promise.allSettled contract). */
async function runWithConcurrency<T>(
  tasks: (() => Promise<T>)[],
  concurrency: number
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length);
  const limit = Math.max(1, Math.min(concurrency, tasks.length));
  let next = 0;
  const runners: Promise<void>[] = [];
  for (let i = 0; i < limit; i++) {
    runners.push(
      (async () => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= tasks.length) return;
          try {
            results[index] = { status: "fulfilled", value: await tasks[index]() };
          } catch (e) {
            results[index] = { status: "rejected", reason: e };
          }
        }
      })()
    );
  }
  await Promise.all(runners);
  return results;
}

function skippedOutcome(address: string, route: SellRoute): SellOutcome {
  return {
    address,
    route,
    status: "skipped",
    reason: "zero token balance",
    tokenSold: BigInt(0),
    solReceivedLamports: BigInt(0),
  };
}

function failedOutcome(
  address: string,
  route: SellRoute,
  e: unknown,
  /** R4 accounting: total send attempts and the confirmed signature of a
   *  failed attempt, when one exists (inspectable revert). */
  extra: { attempts?: number; lastFailedSignature?: string } = {}
): SellOutcome {
  const raw = e instanceof Error ? e.message : String(e);
  // M7a: surface an actionable reason for rate-limit / expired blockhash /
  // insufficient-funds / rent classes instead of the raw RPC text.
  const friendly = friendlyTxError(raw);
  const msg = friendly.length > 180 ? `${friendly.slice(0, 177)}...` : friendly;
  return {
    address,
    route,
    status: "failed",
    reason: msg,
    tokenSold: BigInt(0),
    solReceivedLamports: BigInt(0),
    attempts: extra.attempts,
    lastFailedSignature: extra.lastFailedSignature,
  };
}

/**
 * Sells one keyed wallet's full balance on the open pump.fun bonding curve
 * (the NOT-graduated route). The sell ix is hand-built (lib/pump.ts): the
 * full token balance goes in with a min_sol_output quoted client-side
 * against the curve's VIRTUAL reserves under the slippage band. Confirms
 * the tx and measures the native SOL the wallet received.
 *
 * R1: a slippage revert is retried with a fresh quote (own budget + short
 * jittered backoff); transient RPC failures keep the paced retry; anything
 * else stops. R2: `readCurve` is called on EVERY attempt so the retry never
 * re-quotes the run-level snapshot. A slippage revert means the ix did NOT
 * execute, so a retry cannot double-sell (the balance-drain branch covers the
 * different LOST-CONFIRM case).
 */
async function sellOneCurve(
  connection: Connection,
  mint: PublicKey,
  readCurve: CurveReader,
  wallet: Keypair,
  slippagePct: number,
  /** Live protocol fee recipient (resolvePumpFeeRecipient), resolved once
   *  per sell-all run. */
  feeRecipient: PublicKey,
  /** STAGE 2 folded floor (lamports). On the FIRST attempt the instruction
   *  takes min(this, the fresh quote's floor), so the wallet's floor reflects
   *  the state its predecessors' sells leave while never being tighter than
   *  the quote we would have used anyway. Retries ignore it: the fold is a
   *  snapshot of a plan, the fresh read is the truth. */
  foldedMinSolOut?: bigint,
  /** Share of the wallet's own balance to sell, percent in (0, 100]. Default
   *  100 = the whole bag (the sell-all contract). A partial sell freezes its
   *  amount from the FIRST read, so a retry can never re-sell a position that
   *  already landed (see `remaining` below). */
  sellPct: number = 100
): Promise<SellOutcome> {
  const address = wallet.publicKey.toBase58();
  const slippageBps = BigInt(Math.round(slippagePct * 100));
  let firstBalance = BigInt(0);
  /** Tokens this sell sets out to take and the balance it must leave behind,
   *  both frozen at the first read. `remaining` generalises the "balance
   *  drained" lost-confirm detector to a PARTIAL sell: a wallet that is
   *  already at (or below) its target remainder has sold, it must not sell
   *  again. At the 100% default remaining is 0, i.e. exactly the old check. */
  let soldTokens = BigInt(0);
  let remaining = BigInt(0);
  let lastSolBefore = BigInt(0);
  let lastErr: unknown = null;
  let attempts = 0;
  let slippageRetries = 0;
  let transientRetries = 0;
  let retriedOnSlippage = false;
  let lastFailedSignature: string | undefined;
  for (;;) {
    attempts += 1;
    try {
      const balance = await walletTokenBalance(connection, wallet.publicKey, mint);
      if (attempts === 1) {
        firstBalance = balance;
        soldTokens = pctTokens(firstBalance, sellPct);
        remaining = firstBalance - soldTokens;
      }
      if (soldTokens <= BigInt(0)) {
        // Nothing to sell: a zero balance, or a percentage so small on this
        // balance that it floors to zero raw units (the curve sell would
        // revert on a zero input).
        return skippedOutcome(address, "curve");
      }
      if (balance <= remaining) {
        // At (or below) the target remainder: either there was nothing to
        // sell (skip) or a previous attempt landed and its confirm was lost
        // (report as sold, for exactly the tokens this sell removed).
        if (soldTokens > BigInt(0)) {
          let solNow = lastSolBefore;
          try {
            solNow = BigInt(
              await connection.getBalance(wallet.publicKey, "confirmed")
            );
          } catch {
            // keep the last known before-balance; the report falls back to 0
          }
          return {
            address,
            route: "curve",
            status: "sold",
            reason: "balance drained after a previous attempt (signature lost to RPC)",
            tokenSold: soldTokens,
            solReceivedLamports: BigInt(
              Math.max(0, Number(solNow - lastSolBefore))
            ),
            attempts,
            retriedOnSlippage,
          };
        }
        return skippedOutcome(address, "curve");
      }
      lastSolBefore = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      // R2: FRESH curve read per attempt. Do not hoist this out of the loop:
      // the per-attempt re-read is what makes the slippage retry correct.
      const fresh = await readCurve();
      if (!fresh.ok) {
        // The route was chosen from an earlier successful read; a curve that
        // vanished is a permanent condition, not a price move.
        lastErr = new Error(fresh.reason);
        break;
      }
      const quote = quotePumpSell({
        tokensIn: soldTokens,
        virtualSolReserves: fresh.virtualSolReserves,
        virtualTokenReserves: fresh.virtualTokenReserves,
        slippageBps,
      });
      // STAGE 2: first attempt takes the LOWER of the folded floor and the
      // fresh-quote floor. A folded floor that is somehow tighter than the live
      // quote cannot revert the sell, and a folded floor that is looser absorbs
      // the peers' price impact that the snapshot quote does not see.
      const minSolOutput =
        attempts === 1 &&
        foldedMinSolOut !== undefined &&
        foldedMinSolOut < quote.minSolOutput
          ? foldedMinSolOut
          : quote.minSolOutput;
      const ixs = buildPumpSellIx({
        mint,
        seller: wallet.publicKey,
        creator: fresh.creator,
        feeRecipient,
        tokensIn: soldTokens,
        minSolOutput,
      });
      const tx = new Transaction({ feePayer: wallet.publicKey });
      tx.add(...ixs);
      const signature = await sendRawWithRetry(connection, tx, [wallet], {
        confirmTimeoutMs: 90_000,
      });
      const solAfter = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      return {
        address,
        route: "curve",
        status: "sold",
        tokenSold: soldTokens,
        solReceivedLamports: BigInt(Math.max(0, Number(solAfter - lastSolBefore))),
        signature,
        attempts,
        retriedOnSlippage,
      };
    } catch (e) {
      lastErr = e;
      lastFailedSignature = failedSignatureOf(e) ?? lastFailedSignature;
      const msg = e instanceof Error ? e.message : String(e);
      const cls = classifySellError(msg);
      if (cls === "slippage") {
        if (slippageRetries + 1 >= SLIPPAGE_ATTEMPTS) break;
        slippageRetries += 1;
        retriedOnSlippage = true;
        await sleepMs(slippageBackoffMs(slippageRetries));
        continue;
      }
      if (cls === "transient") {
        if (transientRetries + 1 >= SELL_ATTEMPTS) break;
        transientRetries += 1;
        await sleepMs(SELL_RETRY_BASE_MS * (transientRetries + 1));
        continue;
      }
      break;
    }
  }
  return failedOutcome(address, "curve", lastErr ?? new Error("sell failed"), {
    attempts,
    lastFailedSignature,
  });
}

/** Sells one keyed wallet's full balance on PumpSwap (the graduated route)
 *  by delegating to `sellMigratedPool` (lib/swap.ts): the SDK quotes a fresh
 *  minQuoteAmountOut from the pool state under the slippage band, closes the
 *  wallet's WSOL account so the proceeds land as native SOL, and this wrapper
 *  keeps the retry loop + the sold/skip/fail accounting.
 *
 *  R2 (pool leg): `sellMigratedPool` calls the SDK's swapSolanaState inside
 *  EVERY invocation, so each retry re-quotes the live pool. That per-attempt
 *  re-read is load-bearing — do NOT "optimise" it into one shared read.
 *  pump.fun auto-migrated the curve; the pool + WSOL quote mint stay legacy. */
async function sellOnePumpSwap(
  connection: Connection,
  mint: PublicKey,
  poolKey: PublicKey,
  wallet: Keypair,
  slippagePct: number,
  /** STAGE 2 folded floor (lamports), first attempt only; see sellOneCurve. */
  foldedMinQuoteOut?: bigint,
  /** Share of the wallet's own balance to sell, percent in (0, 100]. Default
   *  100 = the whole bag; see sellOneCurve for the frozen-amount rule. */
  sellPct: number = 100
): Promise<SellOutcome> {
  const address = wallet.publicKey.toBase58();
  let firstBalance = BigInt(0);
  /** Frozen target of this sell (see sellOneCurve): the amount taken and the
   *  balance it must leave, both from the first read, so a partial sell that
   *  landed with a lost confirm is never sold a second time. At 100% the
   *  remainder is 0, i.e. exactly the old drain check. */
  let soldTokens = BigInt(0);
  let remaining = BigInt(0);
  let lastSolBefore = BigInt(0);
  let lastErr: unknown = null;
  let attempts = 0;
  let slippageRetries = 0;
  let transientRetries = 0;
  let retriedOnSlippage = false;
  let lastFailedSignature: string | undefined;
  for (;;) {
    attempts += 1;
    try {
      const balance = await walletTokenBalance(connection, wallet.publicKey, mint);
      if (attempts === 1) {
        firstBalance = balance;
        soldTokens = pctTokens(firstBalance, sellPct);
        remaining = firstBalance - soldTokens;
      }
      if (soldTokens <= BigInt(0)) {
        // Nothing to sell: a zero balance, or a percentage so small on this
        // balance that it floors to zero raw units.
        return skippedOutcome(address, "pumpSwap");
      }
      if (balance <= remaining) {
        // At (or below) the target remainder: a previous attempt landed and
        // its confirm was lost (report as sold, for exactly the tokens this
        // sell removed).
        let solNow = lastSolBefore;
        try {
          solNow = BigInt(
            await connection.getBalance(wallet.publicKey, "confirmed")
          );
        } catch {
          // keep the last known before-balance; the report falls back to 0
        }
        return {
          address,
          route: "pumpSwap",
          status: "sold",
          reason: "balance drained after a previous attempt (signature lost to RPC)",
          tokenSold: soldTokens,
          solReceivedLamports: BigInt(
            Math.max(0, Number(solNow - lastSolBefore))
          ),
          attempts,
          retriedOnSlippage,
        };
      }
      lastSolBefore = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      // R2: the fresh quote is inside sellMigratedPool (swapSolanaState per
      // call). The exact "PumpSwap pool <key> not found (not migrated?)"
      // string it throws is classified below as a permanent stop.
      const result = await sellMigratedPool({
        connection,
        poolKey,
        seller: wallet,
        baseAmount: soldTokens,
        slippagePct,
        // STAGE 2: the folded floor replaces the percent-derived min-out on the
        // first attempt only. It is conservative on both counts the fold
        // controls (a higher total fee, and the whole net leaving the vault),
        // so it can only ever be LOOSER than the live quote's own floor.
        minOutLamports: attempts === 1 ? foldedMinQuoteOut : undefined,
      });
      const solAfter = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      return {
        address,
        route: "pumpSwap",
        status: "sold",
        tokenSold: soldTokens,
        solReceivedLamports: BigInt(
          Math.max(0, Number(solAfter - lastSolBefore))
        ),
        signature: result.signature,
        attempts,
        retriedOnSlippage,
      };
    } catch (e) {
      lastErr = e;
      lastFailedSignature = failedSignatureOf(e) ?? lastFailedSignature;
      const msg = e instanceof Error ? e.message : String(e);
      // A missing pool is a hard (permanent) condition, not transient; keep
      // this string byte-identical or the retryable/permanent classification
      // inverts. Pool rate-limit exhaustion IS transient and retries.
      const poolMissing = /not found \(not migrated\?\)/.test(msg);
      if (poolMissing) break;
      const cls = classifySellError(msg);
      if (cls === "slippage") {
        if (slippageRetries + 1 >= SLIPPAGE_ATTEMPTS) break;
        slippageRetries += 1;
        retriedOnSlippage = true;
        await sleepMs(slippageBackoffMs(slippageRetries));
        continue;
      }
      if (cls === "transient") {
        if (transientRetries + 1 >= SELL_ATTEMPTS) break;
        transientRetries += 1;
        await sleepMs(SELL_RETRY_BASE_MS * (transientRetries + 1));
        continue;
      }
      break;
    }
  }
  return failedOutcome(address, "pumpSwap", lastErr ?? new Error("sell failed"), {
    attempts,
    lastFailedSignature,
  });
}

/** The manual Sell's per-wallet pool leg (a graduated mint has no tradable
 *  curve: every curve sell reverts). Exposed so the trade panel can sell a
 *  CHECKED subset of the roster with the SAME policy Sell All uses on the pool:
 *  a fresh quote per attempt (inside sellMigratedPool), its own slippage
 *  re-quote and transient-RPC budgets, the WSOL account closed in the same tx
 *  so the proceeds land as NATIVE SOL, and an honest per-wallet outcome instead
 *  of a thrown error. `sellPct` sizes the sell from the wallet's LIVE balance
 *  (100 = the whole bag).
 *
 *  The sell-all guard rails apply here too, BEFORE any network call, so a
 *  manual caller cannot slip past them: slippage above MAX_SLIPPAGE_PCT and a
 *  sellPct outside (0, 100] are refused. */
export async function sellOneWalletOnPool(opts: {
  connection: Connection;
  mint: PublicKey;
  poolKey: PublicKey;
  wallet: Keypair;
  /** Share of the wallet's own balance to sell, percent in (0, 100]. */
  sellPct: number;
  /** Slippage band percent (default POOL_SELL_SLIPPAGE_PCT, 100 = a ZERO floor:
   *  the band the Sell All button passes). */
  slippagePct?: number;
  /** STAGE 2 folded floor (lamports), first attempt only. */
  minOutLamports?: bigint;
}): Promise<SellOutcome> {
  const slippagePct = opts.slippagePct ?? POOL_SELL_SLIPPAGE_PCT;
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
  if (!Number.isFinite(opts.sellPct) || opts.sellPct <= 0 || opts.sellPct > 100) {
    throw new Error(
      `sellPct ${opts.sellPct} is outside the allowed range (0, 100] (a sell of nothing is a no-op, not a report)`
    );
  }
  return sellOnePumpSwap(
    opts.connection,
    opts.mint,
    opts.poolKey,
    opts.wallet,
    slippagePct,
    opts.minOutLamports,
    opts.sellPct
  );
}

/** The SELL ALL entry point. Reads the pump.fun curve state once to choose
 *  the route, then sells every keyed wallet's full balance concurrently.
 *  Never throws for a per-wallet failure: each wallet's error is captured in
 *  its outcome and the final report carries the completed count. */
export async function sellAllManagedWallets(
  opts: SellAllOptions
): Promise<SellAllReport> {
  const {
    connection,
    mint,
    wallets,
    poolIndex = CANONICAL_POOL_INDEX,
  } = opts;

  // R3 GUARD RAIL: keep the band SANE (finite, >= 0, <= MAX_SLIPPAGE_PCT)
  // BEFORE any network call. Since 2026-09-14 the operator's sell band IS 100
  // (a zero floor: an exit can never be refused on price, which is the point),
  // so this check no longer forbids the value it used to; it only refuses a
  // non-finite/negative/absurd one. Values above MAX_SLIPPAGE_PCT are refused,
  // never clamped.
  const slippagePct = opts.slippagePct ?? POOL_SELL_SLIPPAGE_PCT;
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

  // Partial sells are a first-class case since 2026-09-13 (the manual Sell
  // passes the roster % input). Validated here, before any network call: the
  // legs size themselves from the live balance with `pctTokens`, which floors,
  // so a percentage that rounds to zero raw units reports SKIPPED per wallet
  // rather than sending a zero-input sell.
  const sellPct = opts.sellPct ?? 100;
  if (!Number.isFinite(sellPct) || sellPct <= 0 || sellPct > 100) {
    throw new Error(
      `sellPct ${sellPct} is outside the allowed range (0, 100] (a sell of nothing is a no-op, not a report)`
    );
  }

  // STAGE 2B GUARD RAIL (before ANY network call): the relay bundle is a
  // MAINNET service. Every relay in lib/bundle/relays.ts (nextblock,
  // astralane, bloxroute) is mainnet only, so "bundle" is refused on a devnet
  // cluster outright — never silently downgraded to per-wallet sends.
  const submit = opts.submit ?? "perWallet";
  if (submit === "bundle" && isNonMainnetCluster(connection)) {
    throw new Error(
      'submit: "bundle" is mainnet only: every relay in lib/bundle/relays.ts ' +
        "(nextblock, astralane, bloxroute) is a mainnet service; there is no " +
        'devnet relay. Use submit: "perWallet" on devnet.'
    );
  }

  // R3: bounded fan-out. Default 3, not wallets.length; `concurrency: 1`
  // serialises the round (each wallet quotes after the previous one landed).
  // Clamped to the number of keyed tasks below.
  const concurrency = Math.max(
    1,
    opts.concurrency ?? DEFAULT_SELL_CONCURRENCY
  );
  const keyedWallets = wallets.filter((w) => w.key);

  // ROUTING: read the pump.fun curve state once. `complete` = 0 -> the curve
  // sell instruction (creator + virtual reserves come from the same read);
  // `complete` = 1 -> the PumpSwap pool the curve auto-migrated to
  // (derived from the recorded creator, index 0).
  const read = await readPumpCurveState(connection, mint);
  if (read.kind === "missing") {
    throw new Error(`curve for mint ${mint.toBase58()} not found (not a pump.fun token?)`);
  }
  const curve = read.curve;
  const graduated = curve.complete;
  const creator = curve.creator.toBase58();

  let poolKey: PublicKey | null = null;
  if (graduated) {
    const lookup = await lookupMigratedPool(connection, mint, poolIndex);
    poolKey = lookup.poolKey;
  }
  const route: SellRoute = graduated ? "pumpSwap" : "curve";

  // Live protocol fee recipient for the curve route (pump.fun rotates it; a
  // stale value reverts every sell with Custom 6000). Resolved once for the
  // whole run; the PumpSwap route does not use it.
  const feeRecipient = await resolvePumpFeeRecipient(connection);

  // R2: per-attempt curve reader. The run-level read above chose the route
  // and derived creator/poolKey; every curve-leg attempt re-reads the live
  // reserves through this so a slippage retry never re-quotes a stale curve.
  const readFreshCurve: CurveReader = async () => {
    const fresh = await readPumpCurveState(connection, mint);
    if (fresh.kind === "missing") {
      return {
        ok: false,
        reason: `curve for mint ${mint.toBase58()} not found (not a pump.fun token?)`,
      };
    }
    return {
      ok: true,
      creator: fresh.curve.creator,
      virtualSolReserves: fresh.curve.virtualSolReserves,
      virtualTokenReserves: fresh.curve.virtualTokenReserves,
    };
  };

  // STAGE 2: plan the folded floors BEFORE any sell is built, so each wallet's
  // floor already accounts for the price impact its predecessors will cause.
  // Non-fatal by design: an empty plan means every wallet quotes fresh, which
  // is today's behaviour. STAGE 2B bundle mode always plans, because the fold
  // is also the bundle ORDER.
  let sequence: SellSequencePlan = {
    steps: [],
    floors: new Map<string, bigint>(),
  };
  const wantFold =
    submit === "bundle" ||
    (opts.foldedFloors !== false && keyedWallets.length > 1);
  if (wantFold) {
    try {
      sequence = await planSellSequence({
        connection,
        mint,
        wallets,
        route,
        poolKey,
        curveVirtualSolReserves: curve.virtualSolReserves,
        curveVirtualTokenReserves: curve.virtualTokenReserves,
        slippagePct,
        sellPct,
      });
    } catch {
      sequence = { steps: [], floors: new Map<string, bigint>() };
    }
  }
  const foldedFloors = sequence.floors;

  // STAGE 2B: ordered atomic relay bundle (mainnet only, guarded above). The
  // fold order is the assembly order; a non-landing bundle is ONE run-level
  // failure and NEVER falls back to per-wallet sends.
  if (submit === "bundle") {
    return sellAllAsBundle({
      connection,
      mint,
      route,
      graduated,
      creator,
      creatorPk: curve.creator,
      feeRecipient,
      poolKey,
      wallets,
      slippagePct,
      sequence,
      useFoldedFloors: opts.foldedFloors !== false,
      tipPayer: opts.tipPayer,
      lookupTableAddress: opts.lookupTableAddress,
    });
  }

  // Each keyed roster wallet signs and pays for its own sell; watch-only rows
  // (no key) are skipped. R3: build lazily-startable tasks and run a bounded
  // pool (was an unbounded Promise.allSettled fan-out). Per-wallet error
  // isolation and the `address: "?"` fallback for a rejected worker remain.
  const tasks = wallets
    .filter((w) => w.key)
    .map((w): (() => Promise<SellOutcome>) => {
      return async () => {
        const secret = w.key as string;
        const wallet = Keypair.fromSecretKey(bs58.decode(secret));
        try {
          if (route === "curve") {
            return await sellOneCurve(
              connection,
              mint,
              readFreshCurve,
              wallet,
              slippagePct,
              feeRecipient,
              foldedFloors.get(w.address),
              sellPct
            );
          }
          return await sellOnePumpSwap(
            connection,
            mint,
            poolKey as PublicKey,
            wallet,
            slippagePct,
            foldedFloors.get(w.address),
            sellPct
          );
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return {
            address: w.address,
            route,
            status: "failed",
            reason: msg.length > 160 ? `${msg.slice(0, 157)}...` : msg,
            tokenSold: BigInt(0),
            solReceivedLamports: BigInt(0),
          };
        }
      };
    });

  const settled = await runWithConcurrency(tasks, concurrency);
  const outcomes: SellOutcome[] = settled.map((r) => {
    if (r.status === "fulfilled") return r.value;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      address: "?",
      route,
      status: "failed",
      reason: msg,
      tokenSold: BigInt(0),
      solReceivedLamports: BigInt(0),
    };
  });

  const keyedCount = keyedWallets.length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const sold = outcomes.filter((o) => o.status === "sold").length;

  let holderCountAfter: number | null = null;
  try {
    holderCountAfter = await holderCount(connection, mint);
  } catch {
    // holder read rate-limited on the public RPC; report null (the caller
    // falls back to the roster balances).
  }

  return {
    route,
    graduated,
    creator,
    poolKey: poolKey ? poolKey.toBase58() : null,
    total: wallets.length,
    skipped: skipped + Math.max(0, wallets.length - keyedCount),
    failed,
    sold,
    outcomes,
    holderCountAfter,
    submit: "perWallet",
  };
}

/** Formats a lamports amount as a short SOL string (engine report helper,
 *  kept here so the UI and tests share one formatter). */
export function formatSolLamports(lamports: bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}

/** STAGE 2/2B: the ordered fold plan. `steps` is the sell ORDER (also the
 *  STAGE 2B bundle assembly order); `floors` is the address -> folded floor
 *  map the per-wallet path consumes. */
export interface SellSequencePlan {
  steps: SellSequenceStep[];
  floors: Map<string, bigint>;
}

export interface SellSequencePlanOptions {
  connection: Connection;
  mint: PublicKey;
  wallets: { address: string; key?: string }[];
  route: SellRoute;
  poolKey: PublicKey | null;
  curveVirtualSolReserves: bigint;
  curveVirtualTokenReserves: bigint;
  slippagePct: number;
  /** Share of each wallet's balance the plan sells, percent in (0, 100].
   *  Default 100. The fold's step amounts ARE the amounts to be sold, so this
   *  must match what the legs will send or the folded floors would be sized
   *  for a different trade (a smaller sell has a smaller floor, so a stale
   *  100% plan would set floors far above what a 50% sell can fetch). */
  sellPct?: number;
  /** Highest tier total (93 + 2 + 30) by default: conservative by design. */
  poolFeeBpsTotal?: bigint;
}

/** STAGE 2 (PLAN-SELLALL-STAGE2.md): plans the folded sell sequence.
 *
 *  Reads every keyed wallet's balance ONCE, then folds the sequence against the
 *  reserves the EARLIER sells leave: `foldCurveSells` on the curve leg, and
 *  `foldPoolSells` on the graduated leg with the starting reserves taken from
 *  the SDK's own swap state (the same read `lib/swap.ts` quotes from).
 *
 *  Returns BOTH the ordered steps and the address -> floor map. Returns an
 *  EMPTY plan instead of throwing when the fold cannot be built: an unfolded
 *  run is exactly today's behaviour, each wallet quoted fresh, which is only
 *  worse in that it may revert once and retry. Never let a planning failure
 *  break a sell-all. */
export async function planSellSequence(
  opts: SellSequencePlanOptions
): Promise<SellSequencePlan> {
  const floors = new Map<string, bigint>();
  const keyed = opts.wallets.filter((w) => w.key);
  if (keyed.length === 0) return { steps: [], floors };
  const balances: { address: string; tokens: bigint }[] = [];
  for (const w of keyed) {
    try {
      const wallet = Keypair.fromSecretKey(bs58.decode(w.key as string));
      const tokens = await walletTokenBalance(
        opts.connection,
        wallet.publicKey,
        opts.mint
      );
      // The fold plans the amounts the legs will actually send: a partial
      // sell folds the partial amount, not the whole balance.
      const selling = pctTokens(tokens, opts.sellPct ?? 100);
      if (selling > BigInt(0)) balances.push({ address: w.address, tokens: selling });
    } catch {
      // One unreadable balance drops that wallet from the plan; the others'
      // floors stay valid because a missing seller only means LESS price
      // impact than planned for, never more.
    }
  }
  if (balances.length === 0) return { steps: [], floors };
  const slippageBps = BigInt(Math.round(opts.slippagePct * 100));
  let steps: SellSequenceStep[] = [];
  if (opts.route === "curve") {
    steps = foldCurveSells({
      balances,
      virtualSolReserves: opts.curveVirtualSolReserves,
      virtualTokenReserves: opts.curveVirtualTokenReserves,
      slippageBps,
    });
  } else if (opts.poolKey) {
    const state = await new OnlinePumpAmmSdk(opts.connection).swapSolanaState(
      opts.poolKey,
      Keypair.fromSecretKey(bs58.decode(keyed[0].key as string)).publicKey
    );
    steps = foldPoolSells({
      balances,
      baseReserve: BigInt(state.poolBaseAmount.toString()),
      quoteReserve: BigInt(state.poolQuoteAmount.toString()),
      virtualQuoteReserves: BigInt(
        state.pool.virtualQuoteReserves.toString()
      ),
      feeBpsTotal: opts.poolFeeBpsTotal ?? BigInt(125),
      slippageBps,
    });
  }
  for (const s of steps) floors.set(s.address, s.minSolOut);
  return { steps, floors };
}

/** STAGE 2 (PLAN-SELLALL-STAGE2.md): address -> folded floor. Empty when fewer
 *  than two keyed wallets can sell (nothing to race), matching the original
 *  behaviour. Thin wrapper over `planSellSequence`, which also exposes the
 *  ORDER the STAGE 2B bundle needs. */
export async function planFoldedFloors(
  opts: SellSequencePlanOptions
): Promise<Map<string, bigint>> {
  const keyed = opts.wallets.filter((w) => w.key);
  if (keyed.length < 2) return new Map<string, bigint>();
  const plan = await planSellSequence(opts);
  if (plan.steps.length < 2) return new Map<string, bigint>();
  return plan.floors;
}

/* ------------------------------------------------------------------ */
/* STAGE 2B: ordered atomic relay bundle                               */
/* ------------------------------------------------------------------ */

/** One wallet's leg of the ordered bundle. */
export interface SellBundleLeg {
  /** Roster address (the fold step). */
  address: string;
  /** The wallet's own keypair (signs its single tx). */
  wallet: Keypair;
  /** The sell instructions that make up this wallet's tx. */
  instructions: TransactionInstruction[];
}

/** The assembled ordered bundle. */
export interface SellBundlePlan {
  /** One unsigned tx per leg, IN FOLD ORDER. */
  txs: Transaction[];
  /** Signers per tx, aligned with `txs`; each tx is signed by its own wallet. */
  signersByTx: Keypair[][];
  /** Roster addresses in bundle (fold) order, aligned with `txs`. */
  order: string[];
  /** STAGE 2B pairing: non-null when the assembled tx count exceeds the
   *  active relay cap. The bundle must NOT be submitted; the caller reports
   *  this readable reason and falls back to `submit: "perWallet"`. */
  overCapReason: string | null;
}

/** Relay tx cap shared by the active Tier 2 relays (nextblock / astralane /
 *  bloxroute) — lib/bundle/relays.ts `RELAY_BUNDLE_CAPS`. The legacy Jito leg
 *  allows 5, but every ACTIVE relay skips a bundle over 4, so 4 is the real
 *  budget. */
export const SELL_BUNDLE_RELAY_TX_CAP = 4;

/** Wallets packed per bundle tx (two sellers with two signers, exactly the
 *  way the launch's fill txs pack two buys per tx). A five-wallet sell is
 *  three txs and fits every active relay; a one-tx-per-wallet assembly is
 *  five txs and is skipped by all of them. */
export const SELL_BUNDLE_WALLETS_PER_TX = 2;

/** Readable over-cap message for a paired bundle plan, or null when the plan
 *  fits. Pure, so the offline suite pins the message. */
export function sellBundleCapError(
  legCount: number,
  walletsPerTx: number = SELL_BUNDLE_WALLETS_PER_TX,
  cap: number = SELL_BUNDLE_RELAY_TX_CAP
): string | null {
  const perTx = Math.max(1, Math.floor(walletsPerTx));
  const txs = Math.ceil(legCount / perTx);
  if (txs <= cap) return null;
  return (
    `bundle pairing: ${legCount} wallet(s) -> ${txs} tx(s) at ${perTx} wallets/tx, ` +
    `over the ${cap}-tx cap shared by the active relays ` +
    `(nextblock/astralane/bloxroute). Re-run with submit: "perWallet" or ` +
    `reduce the selling roster.`
  );
}

/**
 * STAGE 2B: PURE assembly of the ordered sell bundle. It only allocates txs
 * from the caller-built instructions and NEVER touches the network or a relay,
 * so the bundle order is asserted offline. The fold order is the input order:
 * this cannot re-sort the sequence behind the floor plan's back.
 *
 * `walletsPerTx` packs multiple legs into one tx (default 1 = the original
 * one-tx-per-wallet assembly). At 2 the pair's FIRST wallet is the fee payer
 * and BOTH wallets sign; the legs are appended in fold order, so the tx order
 * and the order WITHIN each tx still follow the fold. `relayTxCap`, when
 * given, populates `overCapReason` instead of throwing.
 */
export function buildSellBundlePlan(
  legs: SellBundleLeg[],
  opts: { walletsPerTx?: number; relayTxCap?: number } = {}
): SellBundlePlan {
  const walletsPerTx = Math.max(1, Math.floor(opts.walletsPerTx ?? 1));
  const txs: Transaction[] = [];
  const signersByTx: Keypair[][] = [];
  const order: string[] = [];
  for (let i = 0; i < legs.length; i += walletsPerTx) {
    const group = legs.slice(i, i + walletsPerTx);
    // The pair's FIRST wallet is the fee payer (same rule as the launch's
    // fill txs: the creator is never on a fill/sell tx).
    const tx = new Transaction({ feePayer: group[0].wallet.publicKey });
    const signers: Keypair[] = [];
    for (const leg of group) {
      if (leg.instructions.length > 0) {
        tx.add(...leg.instructions);
      }
      signers.push(leg.wallet);
      order.push(leg.address);
    }
    txs.push(tx);
    signersByTx.push(signers);
  }
  const overCapReason =
    opts.relayTxCap !== undefined && txs.length > opts.relayTxCap
      ? sellBundleCapError(legs.length, walletsPerTx, opts.relayTxCap)
      : null;
  return { txs, signersByTx, order, overCapReason };
}

/* ------------------------------------------------------------------ */
/* STAGE 3 (PLAN-SELLALL-SIZE.md): measured byte-budget packing        */
/* ------------------------------------------------------------------ */

/** Per-tx byte budget for a sell bundle tx (mirrors the launch fill packer:
 *  1150 bytes with a 90-byte tip reserve, so the effective budget is 1060). */
export const DEFAULT_SELL_TX_BYTES = 1150;
/** Bytes reserved in every packed sell tx for the relay tip transfer the
 *  assembler appends (a legacy SystemProgram.transfer is ~90 bytes; a v0 tip
 *  is smaller, so the reserve is conservative on both routes). */
export const SELL_TIP_RESERVE_BYTES = 90;
/** Bounded warm-slot wait for a freshly created/extended lookup table. */
export const SELL_ALT_WAIT_ATTEMPTS = 30;
export const SELL_ALT_WAIT_MS = 400;
/** v0 bundle submission attempts (fresh blockhash, same tip, no escalation). */
export const SELL_BUNDLE_MAX_ATTEMPTS = 3;

/** One packed sell transaction: the tx's instructions in fold order, the
 *  wallets that sign it (index 0 is the fee payer), its measured signed size
 *  WITHOUT the tip (the packer's budget already reserves the tip), and the
 *  legacy materialization for the curve route (null for v0 pool groups). */
export interface PackedSellTx {
  instructions: TransactionInstruction[];
  wallets: Keypair[];
  signedSize: number;
  legacyTx: Transaction | null;
}

export interface PackedSellPlan {
  /** Packed transactions, in fold order, each measured at or below budget. */
  txs: PackedSellTx[];
  /** Readable refusal when the packed tx count exceeds the relay cap. */
  overCapReason: string | null;
  /** True when the groups were compiled as v0 with the ALT (pool route). */
  versioned: boolean;
}

/** Readable over-cap message for the MEASURED packer output. Names the wallet
 *  count, the measured transaction count and the relay cap. */
export function sellBundleTxCapError(
  walletCount: number,
  txCount: number,
  cap: number = SELL_BUNDLE_RELAY_TX_CAP
): string {
  return (
    `bundle packing: ${walletCount} wallet(s) -> ${txCount} tx(s), over the ` +
    `${cap}-tx cap shared by the active relays ` +
    `(nextblock/astralane/bloxroute). Re-run with submit: "perWallet" or ` +
    `reduce the selling roster.`
  );
}

/** The measured instruction shape of a real PumpSwap sell for a seller whose
 *  WSOL account already exists: one AMM `sell` (24 accounts, 24 data bytes)
 *  plus the WSOL close (3 accounts). The shared accounts are module-level so a
 *  synthetic PAIR shares them, exactly like a real pair. Used only for the
 *  pure plan-time capability measurement and the offline size test. */
const POOL_SELL_SHARED_KEYS: PublicKey[] = Array.from(
  { length: 23 },
  () => Keypair.generate().publicKey
);

export function poolSellShapeInstructions(
  seller: PublicKey
): TransactionInstruction[] {
  const sellKeys = [
    { pubkey: seller, isSigner: true, isWritable: true },
    ...POOL_SELL_SHARED_KEYS.map((pubkey) => ({
      pubkey,
      isSigner: false,
      isWritable: true,
    })),
  ];
  const sellIx = new TransactionInstruction({
    keys: sellKeys,
    programId: PUMP_AMM_PROGRAM_ID,
    data: Buffer.alloc(24),
  });
  const closeIx = new TransactionInstruction({
    keys: [
      { pubkey: Keypair.generate().publicKey, isSigner: false, isWritable: true },
      { pubkey: seller, isSigner: false, isWritable: true },
      { pubkey: seller, isSigner: true, isWritable: false },
    ],
    programId: TOKEN_PROGRAM_ID,
    data: Buffer.from([9]),
  });
  return [sellIx, closeIx];
}

/** Every account the legs share (present in more than one leg) plus the
 *  programs a pool sell references. These are the keys the sell ALT must
 *  carry; a key used once stays inline as a full pubkey. */
export function collectSharedLookupAccounts(
  legs: SellBundleLeg[]
): PublicKey[] {
  const counts = new Map<string, { pubkey: PublicKey; n: number }>();
  const bump = (pubkey: PublicKey): void => {
    const k = pubkey.toBase58();
    const entry = counts.get(k);
    if (entry) entry.n += 1;
    else counts.set(k, { pubkey, n: 1 });
  };
  for (const leg of legs) {
    for (const ix of leg.instructions) {
      bump(ix.programId);
      for (const key of ix.keys) bump(key.pubkey);
    }
  }
  const out: PublicKey[] = [
    SystemProgram.programId,
    TOKEN_2022_PROGRAM_ID,
    TOKEN_PROGRAM_ID,
    PUMP_AMM_PROGRAM_ID,
  ];
  const seen = new Set(out.map((p) => p.toBase58()));
  for (const entry of counts.values()) {
    const k = entry.pubkey.toBase58();
    if (entry.n >= 2 && !seen.has(k)) {
      out.push(entry.pubkey);
      seen.add(k);
    }
  }
  return out;
}

/** A pure (never on-chain) ALT for the plan-time size check: the pump
 *  constants `ensurePumpLookupTable` would create plus the sell-shared keys.
 *  Only the `addresses` list matters for size measurement. */
export function syntheticSellLookupTable(
  feeRecipient: PublicKey,
  sharedAddresses: PublicKey[],
  authority: PublicKey
): AddressLookupTableAccount {
  const seen = new Set<string>();
  const addresses: PublicKey[] = [];
  for (const pk of [...pumpLookupAccounts(feeRecipient), ...sharedAddresses]) {
    const k = pk.toBase58();
    if (!seen.has(k)) {
      seen.add(k);
      addresses.push(pk);
    }
  }
  const state: AddressLookupTableState = {
    deactivationSlot: BigInt("18446744073709551615"),
    lastExtendedSlot: 0,
    lastExtendedSlotStartIndex: 0,
    authority,
    addresses,
  };
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state,
  });
}

/** The packer (work item 2). Greedily packs the built legs, IN FOLD ORDER,
 *  into transactions each measured at or below `maxTxBytes - tipReserveBytes`.
 *  With an ALT the groups compile as v0 messages (pool route); without one
 *  they are legacy (curve route). The tx count is an OUTPUT of the measured
 *  sizes, never an assumed wallets-per-tx. Pure and offline. */
export function packSellBundleTxs(
  legs: SellBundleLeg[],
  opts: {
    alt?: AddressLookupTableAccount | null;
    maxTxBytes?: number;
    tipReserveBytes?: number;
    blockhash?: string;
    lastValidBlockHeight?: number;
    relayTxCap?: number;
  } = {}
): PackedSellPlan {
  const alt = opts.alt ?? null;
  const maxTxBytes = opts.maxTxBytes ?? DEFAULT_SELL_TX_BYTES;
  const tipReserveBytes = opts.tipReserveBytes ?? SELL_TIP_RESERVE_BYTES;
  if (maxTxBytes > MAX_TX_BYTES) {
    throw new Error(`maxTxBytes ${maxTxBytes} > hard limit ${MAX_TX_BYTES}`);
  }
  const budget = maxTxBytes - tipReserveBytes;
  const blockhash = opts.blockhash ?? "11111111111111111111111111111111";
  const lastValidBlockHeight = opts.lastValidBlockHeight ?? 0;

  const measure = (group: {
    instructions: TransactionInstruction[];
    wallets: Keypair[];
  }): { size: number; legacyTx: Transaction | null } => {
    if (alt) {
      const message = new TransactionMessage({
        payerKey: group.wallets[0].publicKey,
        recentBlockhash: blockhash,
        instructions: group.instructions,
      }).compileToV0Message([alt]);
      const tx = new VersionedTransaction(message);
      tx.sign(group.wallets);
      return { size: tx.serialize().length, legacyTx: null };
    }
    const tx = new Transaction({
      feePayer: group.wallets[0].publicKey,
      blockhash,
      lastValidBlockHeight,
    });
    tx.add(...group.instructions);
    tx.sign(...group.wallets);
    return { size: tx.serialize().length, legacyTx: tx };
  };

  const out: PackedSellTx[] = [];
  let current: {
    instructions: TransactionInstruction[];
    wallets: Keypair[];
  } | null = null;
  let currentMeasured: { size: number; legacyTx: Transaction | null } = {
    size: 0,
    legacyTx: null,
  };
  for (const leg of legs) {
    if (!current) current = { instructions: [], wallets: [] };
    const candidate: {
      instructions: TransactionInstruction[];
      wallets: Keypair[];
    } = {
      instructions: [...current.instructions, ...leg.instructions],
      wallets: [...current.wallets, leg.wallet],
    };
    const measured = measure(candidate);
    if (current.wallets.length === 0 || measured.size <= budget) {
      current = candidate;
      currentMeasured = measured;
    } else {
      out.push({
        instructions: current.instructions,
        wallets: current.wallets,
        signedSize: currentMeasured.size,
        legacyTx: currentMeasured.legacyTx,
      });
      current = { instructions: [...leg.instructions], wallets: [leg.wallet] };
      currentMeasured = measure(current);
    }
  }
  if (current && current.wallets.length > 0) {
    out.push({
      instructions: current.instructions,
      wallets: current.wallets,
      signedSize: currentMeasured.size,
      legacyTx: currentMeasured.legacyTx,
    });
  }
  // BY CONSTRUCTION: every emitted group must be at or below the budget. A
  // single leg that cannot fit is a hard refusal, never a silent over-size tx
  // and never a fallback (which for a pool leg would itself be over the limit).
  for (const t of out) {
    if (t.signedSize > budget) {
      throw new Error(
        `sell bundle: a ${t.wallets.length}-wallet group serializes to ` +
          `${t.signedSize} bytes, over the ${budget}-byte budget; refusing to ` +
          `build an over-size transaction.`
      );
    }
  }
  const overCapReason =
    opts.relayTxCap !== undefined && out.length > opts.relayTxCap
      ? sellBundleTxCapError(legs.length, out.length, opts.relayTxCap)
      : null;
  return { txs: out, overCapReason, versioned: alt !== null };
}

/** The plan-time capability check input: `count` representative legs for the
 *  route, carrying the REAL measured instruction sizes but dummy accounts.
 *  Pure and offline, so an over-cap roster is refused before any leg or table
 *  is built. */
function representativeSellLegs(
  route: SellRoute,
  count: number,
  opts: { mint: PublicKey; creatorPk: PublicKey; feeRecipient: PublicKey }
): SellBundleLeg[] {
  const legs: SellBundleLeg[] = [];
  for (let i = 0; i < count; i++) {
    const wallet = Keypair.generate();
    const instructions =
      route === "curve"
        ? buildPumpSellIx({
            mint: opts.mint,
            seller: wallet.publicKey,
            creator: opts.creatorPk,
            feeRecipient: opts.feeRecipient,
            tokensIn: BigInt(1_000_000),
            minSolOutput: BigInt(1),
          })
        : poolSellShapeInstructions(wallet.publicKey);
    legs.push({ address: wallet.publicKey.toBase58(), wallet, instructions });
  }
  return legs;
}

/** True when the connection is not a mainnet cluster. The relay bundle path is
 *  mainnet only (lib/bundle/relays.ts has no devnet relay), so this is the hard
 *  gate that runs BEFORE any network call. */
function isNonMainnetCluster(connection: Connection): boolean {
  // The app's declared cluster OR the endpoint host: either being devnet is
  // enough to refuse (safety-first; a mainnet RPC behind a devnet env is still
  // refused, and the mainnet test script sets the env to mainnet).
  if (solanaNetwork() !== "mainnet") return true;
  return /devnet|local|testnet|127\.0\.0\.1|localhost/i.test(
    connection.rpcEndpoint
  );
}

interface BundleRunOptions {
  connection: Connection;
  mint: PublicKey;
  route: SellRoute;
  graduated: boolean;
  creator: string;
  creatorPk: PublicKey;
  feeRecipient: PublicKey;
  poolKey: PublicKey | null;
  wallets: SellableWallet[];
  slippagePct: number;
  /** The fold order + floors; `steps` may be empty (planning failed). */
  sequence: SellSequencePlan;
  /** Apply the folded floor; false quotes each wallet fresh (foldedFloors: false). */
  useFoldedFloors: boolean;
  tipPayer?: Keypair;
  /** STAGE 3: a previously created sell ALT to reuse (see SellAllOptions). */
  lookupTableAddress?: string | null;
}

function errMsgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Token balance with a NULL for an UNKNOWN (RPC error) read, so an
 *  accepted-bundle verification never mistakes a failed read for zero. A
 *  missing ATA is a legitimate zero. */
async function tokenBalanceOrNull(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<bigint | null> {
  const ata = getAssociatedTokenAddressSync(
    mint,
    wallet,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  try {
    const r = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(r.value.amount);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/could not find account|not found|invalid param/i.test(msg)) {
      return BigInt(0);
    }
    return null;
  }
}

/** Conservative on-chain check that an ACCEPTED (pending) bundle landed:
 *  every leg wallet's token balance must reach exactly zero. A read that
 *  fails is NOT treated as zero, so an RPC blip can never fabricate a landing.
 *  Bounded; a persistent unknown reports not-landed. */
async function verifyBundleLanded(
  connection: Connection,
  mint: PublicKey,
  legs: SellBundleLeg[],
  attempts = 6,
  delayMs = 1_500
): Promise<boolean> {
  for (let i = 0; i < attempts; i++) {
    let allZero = true;
    for (const leg of legs) {
      const bal = await tokenBalanceOrNull(connection, leg.wallet.publicKey, mint);
      if (bal !== BigInt(0)) {
        allZero = false;
        break;
      }
    }
    if (allZero) return true;
    if (i + 1 < attempts) await sleepMs(delayMs);
  }
  return false;
}

/** Post-run holder count (rate-limit tolerant: null on a failed read). */
async function readHolderCountSafe(
  connection: Connection,
  mint: PublicKey
): Promise<number | null> {
  try {
    return await holderCount(connection, mint);
  } catch {
    return null;
  }
}

/** The relay + failure text for an atomic bundle that did not land, e.g.
 *  "relay nextblock did not land (rejected): all attempts rejected...". */
function bundleFailureReason(submission: BundleSubmissionResult): string {
  const attempts = submission.attempts;
  const last = attempts[attempts.length - 1];
  const detail =
    last?.rejectionReason ??
    last?.rejectionMsg ??
    last?.sendError ??
    submission.note ??
    `outcome ${submission.outcome}`;
  const relayLabel = last?.winningRelay
    ? `relay ${last.winningRelay}`
    : "relay bundle";
  return `${relayLabel} did not land (${submission.outcome}): ${detail}`;
}

/** The relay-label + attempt count of a bundle submission result (the last
 *  attempt carries the winning relay for an accepted bundle). */
function bundleInfoOf(submission: BundleSubmissionResult): {
  relay: string | null;
  bundleId: string | null;
  attempts: number;
  note: string | null;
} {
  let relay: string | null = null;
  for (const a of submission.attempts) {
    if (a.winningRelay) relay = a.winningRelay;
  }
  return {
    relay,
    bundleId: submission.bundleId ?? null,
    attempts: submission.attempts.length,
    note: submission.note ?? null,
  };
}

/** ONE run-level failure for a non-landing atomic bundle: no per-wallet
 *  successes, and never a silent fallback to per-wallet sends. */
function bundleRunFailure(
  opts: BundleRunOptions,
  skipped: SellOutcome[],
  keyed: SellableWallet[],
  reason: string,
  holderCountAfter: number | null,
  bundleInfo?: {
    relay: string | null;
    bundleId: string | null;
    attempts: number;
    note: string | null;
  }
): SellAllReport {
  return {
    route: opts.route,
    graduated: opts.graduated,
    creator: opts.creator,
    poolKey: opts.poolKey ? opts.poolKey.toBase58() : null,
    total: opts.wallets.length,
    skipped: skipped.length + Math.max(0, opts.wallets.length - keyed.length),
    failed: 1,
    sold: 0,
    outcomes: [
      ...skipped,
      {
        address: "bundle",
        route: opts.route,
        status: "failed",
        reason: reason.length > 300 ? `${reason.slice(0, 297)}...` : reason,
        tokenSold: BigInt(0),
        solReceivedLamports: BigInt(0),
      },
    ],
    holderCountAfter,
    submit: "bundle",
    bundleRelay: bundleInfo?.relay ?? null,
    bundleId: bundleInfo?.bundleId ?? null,
    bundleAttempts: bundleInfo?.attempts,
    bundleNote: bundleInfo?.note ?? reason,
  };
}

/* ------------------------------------------------------------------ */
/* STAGE 3: sell lookup table + v0 bundle submission (PLAN-SELLALL-SIZE) */
/* ------------------------------------------------------------------ */

/** Creates/reuses the shared pump ALT through `ensurePumpLookupTable`, EXTENDS
 *  it with the sell-shared pool/mint/ATA keys it does not already carry, and
 *  bounded-polls until the table's `lastExtendedSlot` is in the past (a table
 *  extended this slot cannot be referenced by a v0 message yet). On timeout it
 *  THROWS: a two-pool-sell legacy pair is over the 1232-byte limit, so there
 *  is deliberately no fallback. */
async function ensureUsableSellLookupTable(
  connection: Connection,
  payer: Keypair,
  sharedAddresses: PublicKey[],
  cachedAddress?: string | null
): Promise<{ account: AddressLookupTableAccount; address: PublicKey }> {
  const base = await ensurePumpLookupTable(connection, payer, cachedAddress);
  const address = base.address;
  let account = base.account;
  const have = new Set(account.state.addresses.map((a) => a.toBase58()));
  const missing: PublicKey[] = [];
  for (const pk of sharedAddresses) {
    const k = pk.toBase58();
    if (!have.has(k)) {
      have.add(k);
      missing.push(pk);
    }
  }
  if (missing.length > 0) {
    const extendIx = AddressLookupTableProgram.extendLookupTable({
      payer: payer.publicKey,
      authority: payer.publicKey,
      lookupTable: address,
      addresses: missing,
    });
    const latest = await connection.getLatestBlockhash("confirmed");
    const tx = new Transaction({
      feePayer: payer.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    tx.add(extendIx);
    const sig = await connection.sendTransaction(tx, [payer], {
      skipPreflight: true,
    });
    await connection.confirmTransaction(
      {
        signature: sig,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      },
      "confirmed"
    );
  }
  for (let i = 0; i < SELL_ALT_WAIT_ATTEMPTS; i++) {
    const fetched = await connection.getAddressLookupTable(address);
    if (fetched.value) {
      account = fetched.value;
      const slot = await connection.getSlot("confirmed");
      if (account.state.lastExtendedSlot < slot) return { account, address };
    }
    await sleepMs(SELL_ALT_WAIT_MS);
  }
  throw new Error(
    `sell bundle: address lookup table ${address.toBase58()} is still warming ` +
      `after ${SELL_ALT_WAIT_ATTEMPTS * SELL_ALT_WAIT_MS}ms; refusing to build ` +
      `a legacy pool pair (a two-pool-sell legacy tx is over the 1232-byte limit).`
  );
}

interface V0RelayVariant {
  base64: string[];
  tipAccount: string;
  signedTxs: VersionedTransaction[];
}

/** v0 provider-specific variant assembly: each group compiles to a v0 message
 *  with the ALT, the relay tip transfer is appended to the LAST group, and the
 *  last group is signed by its wallets plus the tip payer. The v0 twin of
 *  `JitoBundleClient.assembleBundle`, which only clones legacy Transactions
 *  (which is why a v0 sell bundle cannot use the shared submitter). */
async function assembleV0RelayVariant(opts: {
  txs: PackedSellTx[];
  alt: AddressLookupTableAccount;
  blockhash: string;
  tipAccount: PublicKey;
  tipLamports: number;
  tipPayer: Keypair;
}): Promise<{ base64: string[]; signedTxs: VersionedTransaction[] }> {
  const { txs, alt, blockhash, tipAccount, tipLamports, tipPayer } = opts;
  const signedTxs: VersionedTransaction[] = [];
  for (let i = 0; i < txs.length; i++) {
    const isLast = i === txs.length - 1;
    const instructions = [...txs[i].instructions];
    if (isLast) {
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: tipPayer.publicKey,
          toPubkey: tipAccount,
          lamports: tipLamports,
        })
      );
    }
    const message = new TransactionMessage({
      payerKey: txs[i].wallets[0].publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message([alt]);
    const tx = new VersionedTransaction(message);
    const signers = [...txs[i].wallets];
    if (
      isLast &&
      !signers.some((k) => k.publicKey.equals(tipPayer.publicKey))
    ) {
      signers.push(tipPayer);
    }
    tx.sign(signers);
    signedTxs.push(tx);
  }
  return {
    base64: signedTxs.map((t) => Buffer.from(t.serialize()).toString("base64")),
    signedTxs,
  };
}

/** The v0 sell-bundle submitter. Reuses the relay proxy and the official
 *  per-relay tip accounts; fresh blockhash per attempt, same tip, no
 *  escalation, no per-wallet fallback. Returns the same
 *  BundleSubmissionResult shape the legacy submitter does. */
async function submitV0SellBundle(opts: {
  connection: Connection;
  txs: PackedSellTx[];
  alt: AddressLookupTableAccount;
  tipPayer: Keypair;
  initialTipLamports?: number;
  relays?: RelayId[];
  maxAttempts?: number;
}): Promise<BundleSubmissionResult> {
  const { connection, txs, alt, tipPayer } = opts;
  const relays = opts.relays ?? RELAY_ORDER;
  const tipLamports = Math.max(
    opts.initialTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS,
    ...relays.map((r) => RELAY_MIN_TIP_LAMPORTS[r])
  );
  const maxAttempts = opts.maxAttempts ?? SELL_BUNDLE_MAX_ATTEMPTS;
  const attempts: BundleAttempt[] = [];
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleepMs(1_200);
    let latest: { blockhash: string; lastValidBlockHeight: number };
    try {
      latest = await connection.getLatestBlockhash("confirmed");
    } catch (e) {
      attempts.push({
        attempt: i + 1,
        tipLamports,
        sendError: `blockhash: ${errMsgOf(e)}`,
      });
      continue;
    }
    const variants: Partial<Record<RelayId, V0RelayVariant>> = {};
    for (const relay of relays) {
      const tipAccount = new PublicKey(defaultTipAccountForRelay(relay));
      try {
        const assembled = await assembleV0RelayVariant({
          txs,
          alt,
          blockhash: latest.blockhash,
          tipAccount,
          tipLamports,
          tipPayer,
        });
        variants[relay] = {
          base64: assembled.base64,
          tipAccount: tipAccount.toBase58(),
          signedTxs: assembled.signedTxs,
        };
      } catch (e) {
        attempts.push({
          attempt: i + 1,
          tipLamports,
          sendError: `assemble ${relay}: ${errMsgOf(e)}`,
        });
      }
    }
    const bundles: Partial<Record<RelayId, string[]>> = {};
    for (const [relay, variant] of Object.entries(variants) as [
      RelayId,
      V0RelayVariant
    ][]) {
      bundles[relay] = variant.base64;
    }
    if (Object.keys(bundles).length === 0) {
      attempts.push({
        attempt: i + 1,
        tipLamports,
        sendError: "no relay variant assembled",
      });
      continue;
    }
    let fanout;
    try {
      fanout = await submitBundleViaRelayProxy({ bundles, relays });
    } catch (e) {
      attempts.push({
        attempt: i + 1,
        tipLamports,
        sendError: `relay proxy: ${errMsgOf(e)}`,
      });
      continue;
    }
    const winner = fanout.accepted;
    if (winner) {
      attempts.push({
        attempt: i + 1,
        tipLamports,
        bundleId: winner.bundleId,
        status: `accepted by ${winner.relay}`,
        winningRelay: winner.relay,
      });
      const tipAcct = variants[winner.relay]?.tipAccount ?? "n/a";
      return {
        outcome: "pending",
        bundleId: winner.bundleId,
        attempts,
        note: `${winner.relay} accepted the v0 sell bundle (${summarizeFanout(fanout)}; tip -> ${tipAcct}); no relay status API exists — on-chain verification decides landing`,
      };
    }
    attempts.push({
      attempt: i + 1,
      tipLamports,
      sendError: fanout.legs.length
        ? summarizeFanout(fanout)
        : "no relay accepted (all disabled/skipped)",
    });
  }
  return {
    outcome: "rejected",
    attempts,
    note: "all v0 sell-bundle attempts rejected or failed to land",
  };
}

/** STAGE 2B/3: the ordered atomic bundle path.
 *
 *  STAGE 3 (PLAN-SELLALL-SIZE.md) makes an over-size tx impossible by
 *  construction: a plan-time cap refusal runs BEFORE any leg/table is built, a
 *  pool leg's lookup table is acquired and warmed before the leg is packed, and
 *  the packer groups the FOLD-ordered legs by MEASURED signed size (v0 + ALT
 *  for the pool route, legacy for the curve route) under the 1150 - 90 byte
 *  budget. A non-landing bundle is ONE run-level failure; this never falls
 *  back to the per-wallet fan-out and never falls back from v0 to a legacy
 *  pool pair. */
async function sellAllAsBundle(opts: BundleRunOptions): Promise<SellAllReport> {
  const { connection, mint, route, poolKey } = opts;
  const keyed = opts.wallets.filter((w) => w.key);

  // PLAN-TIME CAPABILITY CHECK (PLAN-SELLALL-SIZE work item 4). Before a
  // single real leg is built or a lookup table is created, pack
  // REPRESENTATIVE legs for the requested roster and measure the tx count.
  // Over the active relay cap: refuse up front with a readable message. This
  // is a planning decision, not a size error surfacing mid-run.
  if (keyed.length > 0) {
    const representative = representativeSellLegs(route, keyed.length, {
      mint,
      creatorPk: opts.creatorPk,
      feeRecipient: opts.feeRecipient,
    });
    const planAlt =
      route === "pumpSwap"
        ? syntheticSellLookupTable(
            opts.feeRecipient,
            collectSharedLookupAccounts(representative),
            opts.creatorPk
          )
        : null;
    const planned = packSellBundleTxs(representative, {
      alt: planAlt,
      relayTxCap: SELL_BUNDLE_RELAY_TX_CAP,
    });
    if (planned.overCapReason) {
      return bundleRunFailure(
        opts,
        [],
        keyed,
        planned.overCapReason,
        await readHolderCountSafe(connection, mint)
      );
    }
  }

  const keypairByAddress = new Map<string, Keypair>();
  for (const w of keyed) {
    keypairByAddress.set(
      w.address,
      Keypair.fromSecretKey(bs58.decode(w.key as string))
    );
  }

  const onlineSdk = route === "pumpSwap" ? new OnlinePumpAmmSdk(connection) : null;
  const sdk = route === "pumpSwap" ? new PumpAmmSdk() : null;
  const slippageBps = BigInt(Math.round(opts.slippagePct * 100));

  const legs: SellBundleLeg[] = [];
  const legTokensIn: bigint[] = [];
  const skipped: SellOutcome[] = [];
  const covered = new Set<string>();

  /** One wallet's tx instructions. `foldedMinSolOut` is undefined when there
   *  is no fold floor (fold disabled / wallet outside the fold): the leg then
   *  takes a FRESH quote exactly like the per-wallet path. */
  const buildLeg = async (
    address: string,
    wallet: Keypair,
    tokensIn: bigint,
    foldedMinSolOut: bigint | undefined
  ): Promise<SellBundleLeg> => {
    if (route === "curve") {
      let minSolOutput = foldedMinSolOut;
      if (minSolOutput === undefined) {
        const fresh = await readPumpCurveState(connection, mint);
        if (fresh.kind !== "ok") {
          throw new Error(
            `curve for mint ${mint.toBase58()} not found (not a pump.fun token?)`
          );
        }
        minSolOutput = quotePumpSell({
          tokensIn,
          virtualSolReserves: fresh.curve.virtualSolReserves,
          virtualTokenReserves: fresh.curve.virtualTokenReserves,
          slippageBps,
        }).minSolOutput;
      }
      const instructions = buildPumpSellIx({
        mint,
        seller: wallet.publicKey,
        creator: opts.creatorPk,
        feeRecipient: opts.feeRecipient,
        tokensIn,
        minSolOutput,
      });
      return { address, wallet, instructions };
    }
    if (!poolKey || !onlineSdk || !sdk) {
      throw new Error("bundle pumpSwap leg requires a canonical pool");
    }
    // The ATAs are per user, so the swap state is read per wallet (the same
    // read lib/swap.ts quotes from).
    const state = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);
    const base = new BN(tokensIn.toString());
    // An explicit (folded) floor goes to the instruction DIRECTLY, so it must
    // never be tighter than the SDK's own percent floor for this same state.
    // poolPercentFloor is pure math over the state we just read (see its doc
    // for the measured 1-lamport case), so the looser of the two is used and a
    // folded floor can only ever loosen the trade.
    const floor =
      foldedMinSolOut === undefined
        ? undefined
        : (() => {
            const percentFloor = poolPercentFloor(
              state,
              tokensIn,
              opts.slippagePct
            );
            return foldedMinSolOut < percentFloor
              ? foldedMinSolOut
              : percentFloor;
          })();
    const instructions =
      floor === undefined
        ? await sdk.sellBaseInput(state, base, opts.slippagePct)
        : await sdk.sellInstructions(state, base, new BN(floor.toString()));
    return { address, wallet, instructions };
  };

  // 1) Fold order first (the whole point of bundle mode).
  for (const step of opts.sequence.steps) {
    const wallet = keypairByAddress.get(step.address);
    if (!wallet) continue;
    covered.add(step.address);
    legs.push(
      await buildLeg(
        step.address,
        wallet,
        step.tokensIn,
        opts.useFoldedFloors ? step.minSolOut : undefined
      )
    );
    legTokensIn.push(step.tokensIn);
  }
  // 2) Keyed wallets the fold did not cover (zero balance at plan time, or a
  //    planning failure): read live; zero is a skip, positive gets a fresh
  //    quote appended after the fold order.
  for (const w of keyed) {
    if (covered.has(w.address)) continue;
    const wallet = keypairByAddress.get(w.address) as Keypair;
    let tokens = BigInt(0);
    try {
      tokens = await walletTokenBalance(connection, wallet.publicKey, mint);
    } catch {
      tokens = BigInt(0);
    }
    if (tokens <= BigInt(0)) {
      skipped.push(skippedOutcome(w.address, route));
      continue;
    }
    covered.add(w.address);
    legs.push(await buildLeg(w.address, wallet, tokens, undefined));
    legTokensIn.push(tokens);
  }

  if (legs.length === 0) {
    return {
      route,
      graduated: opts.graduated,
      creator: opts.creator,
      poolKey: poolKey ? poolKey.toBase58() : null,
      total: opts.wallets.length,
      skipped:
        skipped.length + Math.max(0, opts.wallets.length - keyed.length),
      failed: 0,
      sold: 0,
      outcomes: [...skipped],
      holderCountAfter: await readHolderCountSafe(connection, mint),
      submit: "bundle",
      bundleRelay: null,
      bundleId: null,
      bundleAttempts: 0,
      bundleNote: null,
    };
  }

  // ACQUIRE THE LOOKUP TABLE (pool route only) BEFORE the v0 legs are packed.
  // The table is created/reused through `ensurePumpLookupTable`, extended with
  // the sell-shared keys, and warmed (bounded poll). A table that never warms
  // throws a refusal here: a legacy pool pair is over the 1232-byte limit, so
  // there is deliberately no fallback.
  const alt =
    route === "pumpSwap"
      ? (
          await ensureUsableSellLookupTable(
            connection,
            legs[0].wallet,
            collectSharedLookupAccounts(legs),
            opts.lookupTableAddress
          )
        ).account
      : null;

  // MEASURED byte-budget packing (PLAN-SELLALL-SIZE work item 2). The tx count
  // and the wallets-per-tx are OUTPUTS of the signed sizes against the
  // 1150 - 90 budget; the fold order is preserved across and within the groups.
  const packed = packSellBundleTxs(legs, {
    alt,
    relayTxCap: SELL_BUNDLE_RELAY_TX_CAP,
  });
  if (packed.overCapReason) {
    return bundleRunFailure(
      opts,
      skipped,
      keyed,
      packed.overCapReason,
      await readHolderCountSafe(connection, mint)
    );
  }
  const tipPayer = opts.tipPayer ?? legs[0].wallet;

  // Pre-submit SOL balances, so a landed bundle reports the real SOL delta.
  const solBefore = new Map<string, bigint>();
  for (const leg of legs) {
    try {
      solBefore.set(
        leg.address,
        BigInt(await connection.getBalance(leg.wallet.publicKey, "confirmed"))
      );
    } catch {
      solBefore.set(leg.address, BigInt(0));
    }
  }

  let submission: BundleSubmissionResult;
  try {
    if (packed.versioned && alt) {
      // Pool route: v0 messages with the ALT. The shared legacy submitter
      // cannot carry a VersionedTransaction, so the v0 twin posts through the
      // same relay proxy with the same tip accounts and retry shape.
      submission = await submitV0SellBundle({
        connection,
        txs: packed.txs,
        alt,
        tipPayer,
      });
    } else {
      // Curve route: legacy txs (they fit) through the existing submitter.
      const txs: Transaction[] = [];
      for (const t of packed.txs) {
        if (!t.legacyTx) {
          throw new Error(
            "sell bundle: a legacy group is missing its transaction"
          );
        }
        txs.push(t.legacyTx);
      }
      const signersByTx = packed.txs.map((t) => [...t.wallets]);
      const lastIdx = signersByTx.length - 1;
      // The shared relay assembler appends the tip transfer to the LAST tx and
      // then signs that tx with signersByTx[last]; the tip payer's signature
      // must be present or the relay rejects the bundle.
      if (
        !signersByTx[lastIdx].some((k) =>
          k.publicKey.equals(tipPayer.publicKey)
        )
      ) {
        signersByTx[lastIdx] = [...signersByTx[lastIdx], tipPayer];
      }
      submission = await submitBundleViaFanoutWithRetry({
        txs,
        signersByTx,
        tipPayer,
        connection,
      });
    }
  } catch (e) {
    return bundleRunFailure(
      opts,
      skipped,
      keyed,
      `bundle submission threw: ${errMsgOf(e)}`,
      await readHolderCountSafe(connection, mint)
    );
  }

  // NextBlock/Astralane/bloXroute expose no bundle status API, so every
  // accept comes back "pending": verify the landing on chain rather than
  // fabricate it. A rejected/unreachable bundle never lands (atomic), so it is
  // ONE run-level failure with the relay + failure text.
  const landed =
    submission.outcome === "landed" ||
    (submission.outcome === "pending" &&
      (await verifyBundleLanded(connection, mint, legs)));
  const holderCountAfter = await readHolderCountSafe(connection, mint);

  if (!landed) {
    return bundleRunFailure(
      opts,
      skipped,
      keyed,
      bundleFailureReason(submission),
      holderCountAfter,
      bundleInfoOf(submission)
    );
  }

  const outcomes: SellOutcome[] = [...skipped];
  for (let i = 0; i < legs.length; i++) {
    let solReceived = BigInt(0);
    try {
      const after = BigInt(
        await connection.getBalance(legs[i].wallet.publicKey, "confirmed")
      );
      const before = solBefore.get(legs[i].address) ?? BigInt(0);
      solReceived = after > before ? after - before : BigInt(0);
    } catch {
      solReceived = BigInt(0);
    }
    outcomes.push({
      address: legs[i].address,
      route,
      status: "sold",
      tokenSold: legTokensIn[i],
      solReceivedLamports: solReceived,
      signature: submission.bundleId,
    });
  }

  return {
    route,
    graduated: opts.graduated,
    creator: opts.creator,
    poolKey: poolKey ? poolKey.toBase58() : null,
    total: opts.wallets.length,
    skipped: skipped.length + Math.max(0, opts.wallets.length - keyed.length),
    failed: 0,
    sold: legs.length,
    outcomes,
    holderCountAfter,
    submit: "bundle",
    bundleRelay: bundleInfoOf(submission).relay,
    bundleId: submission.bundleId ?? null,
    bundleAttempts: submission.attempts.length,
    bundleNote: submission.note ?? null,
  };
}
