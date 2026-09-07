// Front-running-protected single-tx send for the MANUAL + AUTO buy/sell
// engines (lib/batch-trade.ts and lib/auto.ts) AND the sequential LAUNCH
// path (sendSequentially in lib/bundle/launch.ts), via Helius Sender's
// SWQOS-ONLY tier (sender.helius-rpc.com/fast?swqos_only=true). One sender
// for all four trade paths and the launch: the launch txs go through
// sendProtectedTx with skipPriorityFeeIx (their own setComputeUnitPrice ix
// is already in the tx) so the submission layer stays in one place.
//
// WHY HELIUS SENDER (not Jito): the earlier Jito single-tx bundle path
// (client.sendBundle to the block engine) kept coming back "accepted then
// Invalid" — the same drop the repo already documented for the launch flow,
// which is why Jito was demoted there. Helius Sender is a plain sendTransaction
// to a low-latency endpoint that returns the TX SIGNATURE directly, so
// there is no bundle id and no status polling to mis-handle. SWQOS-only is
// the cost-optimized tier: one fast pathway at the lowest tip.
//
// On MAINNET each submitted tx carries:
//   1. a priority fee (setComputeUnitPrice) — REQUIRED by Sender on EVERY
//      tx. The buy/sell txs carry none, so sendProtectedTx prepends one;
//      the launch txs (lib/bundle/launch.ts) already carry one, so a second
//      must NOT be added (skipPriorityFeeIx: true);
//   2. the trade/launch instructions;
//   3. a flat 5,000-lamport (0.000005 SOL) tip transfer to a Helius Sender
//      tip account, LAST (the tip transfer must be the final instruction).
// ?swqos_only=true selects the single SWQOS pathway whose minimum tip is
// 0.000005 SOL (tips below the 0.001 SOL Sender-Max floor do not enter the
// priority tip buffer). ?mev-protect=true routes around validators
// statistically linked to sandwich attacks — the front-running protection
// that replaces the old Jito bundle. Drop mev-protect to maximize inclusion
// pathways instead.
//
// On DEVNET the Helius Sender endpoint is mainnet-only in practice, so it
// falls back to the plain raw-RPC send (sendAndConfirmWithRetry) unchanged.
//
// Failure semantics mirror sendAndConfirmWithRetry (lib/bundle/launch.ts):
//   - An expired blockhash is re-submitted with a FRESH blockhash (safe: an
//     expired tx can never land).
//   - A confirm timeout or an on-chain revert is surfaced, never silently
//     re-fired (a timed-out tx may still land; re-sending could double a buy).

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS } from "../fees";
import { solanaNetwork } from "../network";
import { isBlockhashExpiredError } from "../tx-errors";
import { sendAndConfirmWithRetry, withTimeout } from "./launch";

/** Helius Sender SWQOS-only endpoint. ?swqos_only=true selects the single
 *  SWQOS pathway (minimum tip 0.000005 SOL); ?mev-protect=true routes
 *  around validators statistically linked to sandwich attacks
 *  (front-running protection). */
export const HELIUS_SENDER_URL =
  "https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true";

/** Helius Sender tip accounts: the SOL transfer that pays for priority
 *  landing. SWQOS-only requires >= 0.000005 SOL (5,000 lamports). Source:
 *  helius.dev/docs/sending-transactions/sender-swqos-only (the documented
 *  list). */
export const HELIUS_SENDER_TIP_ACCOUNTS: string[] = [
  "4ACfpUFoaSD9bfPdeu6DBt89gB6ENTeHBXCAi87NhDEE",
  "D2L6yPZ2FmmmTKPgzaMKdhu6EWZcTpLy1Vhx8uvZe7NZ",
  "9bnz4RShgq1hAnLnZbP8kbgBg1kEmcJBYQq3gQbmnSta",
  "5VY91ws6B2hMmBFRsXkoAAdsPHBJwRfBht4DXox3xkwn",
  "2nyhqdwKcJZR2vcqCyrYsaPVdAnFoJjiksCXJ7hfEYgD",
  "2q5pghRs6arqVjRvT5gfgWfWcHWmw1ZuCzphgd5KfWGJ",
  "wyvPkWjVZz1M8fHQnMMCDTQDbkManefNNhweYk5WkcF",
  "3KCKozbAaF75qEU33jtzozcJ29yJuaLJTy2jFdzUY8bT",
  "4vieeGHPYPG2MmyPRcYjdiDmmhN3ww7hsFNap8pVN3Ey",
  "4TQLFNWK8AovT1gFvda5jfw2oJeRMKEmw7aH6MGBJ3or",
];

/** SWQOS-only tip, lamports: a FLAT 5,000 (0.000005 SOL, the tier minimum).
 *  Deliberately NOT clamped up to DEFAULT_JITO_TIP_LAMPORTS (1_000_000 =
 *  0.001 SOL, the Sender-Max / relay floor): that clamp silently kept every
 *  trade at 0.001 SOL; the whole point of the SWQOS-only tier is the
 *  lowest-tip path. */
const HELIUS_SENDER_SWQOS_TIP_LAMPORTS = 5_000;

/** A send + confirm function with the same shape as sendAndConfirmWithRetry:
 *  (connection, tx, signers, opts) -> { signature }. Swapped into the buy/sell
 *  workers so the whole engine is front-running-protected on mainnet. */
export type SendTx = (
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts?: { attempts?: number; confirmTimeoutMs?: number; label?: string }
) => Promise<{ signature: string }>;

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface ProtectedSendOptions {
  attempts?: number;
  confirmTimeoutMs?: number;
  label?: string;
  /** Tip in lamports; default the SWQOS-only flat 5,000 (0.000005 SOL). */
  tipLamports?: number;
  /** Pre-resolved tip account; defaults to a random Helius Sender account. */
  tipAccount?: PublicKey;
  /** True when the tx's instructions ALREADY carry a setComputeUnitPrice ix
   *  (the launch txs built by lib/bundle/launch.ts always do). sendProtectedTx
   *  prepends its own priority-fee ix by default because the buy/sell txs
   *  carry none; with this flag it skips that so a tx never ends up with TWO
   *  compute-unit-price instructions. */
  skipPriorityFeeIx?: boolean;
}

/** The Sender tip (lamports) actually paid on mainnet, 0 on devnet. A flat
 *  5,000 (0.000005 SOL): the SWQOS-only minimum. No DEFAULT_JITO_TIP_LAMPORTS
 *  clamp — that would silently keep the tip at 0.001 SOL. */
export function protectedTipLamports(): number {
  if (solanaNetwork() !== "mainnet") return 0;
  return HELIUS_SENDER_SWQOS_TIP_LAMPORTS;
}

/** The priority fee (lamports) a mainnet buy/sell pays, 0 on devnet. Estimated
 *  as the configured micro-lamports/CU price times a ~250k-CU trade (the
 *  measured pump.fun buy ceiling). */
export function protectedPriorityFeeReserve(): number {
  if (solanaNetwork() !== "mainnet") return 0;
  return Math.round((DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS * 250_000) / 1_000_000);
}

/** Total extra lamports a MAINNET buy must reserve above the fee/rent floor:
 *  the Sender tip (flat 5,000) + the priority fee. 0 on devnet. The buy's
 *  spendable-SOL formulas subtract this so a buy never quotes an amount it
 *  cannot cover. */
export function protectedReserveLamports(): number {
  return protectedTipLamports() + protectedPriorityFeeReserve();
}

/** Picks a Helius Sender tip account at random (spreads write-lock contention
 *  across a concurrent batch). */
function pickSenderTipAccount(): PublicKey {
  const list = HELIUS_SENDER_TIP_ACCOUNTS;
  return new PublicKey(list[Math.floor(Math.random() * list.length)]);
}

/** POSTs a base64 signed tx to Helius Sender as sendTransaction and returns
 *  the signature (json.result). Sender has no bundle id / status API. */
async function senderSend(base64: string): Promise<string> {
  const res = await fetch(HELIUS_SENDER_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "sendTransaction",
      params: [
        base64,
        { encoding: "base64", skipPreflight: true, maxRetries: 0 },
      ],
    }),
  });
  if (!res.ok) throw new Error(`sender HTTP ${res.status}`);
  const json = (await res.json()) as {
    result?: string;
    error?: { message?: string };
  };
  if (json.error) throw new Error(json.error.message ?? "sender error");
  if (!json.result) throw new Error("sender returned no signature");
  return json.result;
}

/**
 * Sends ONE signed tx with front-running protection. Mainnet: Helius Sender
 * SWQOS-only (priority fee + flat 5,000-lamport tip, mev-protect) confirmed
 * on-chain by signature. Devnet: plain sendAndConfirmWithRetry (no block
 * engine).
 */
export async function sendProtectedTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts: ProtectedSendOptions = {}
): Promise<{ signature: string }> {
  if (solanaNetwork() !== "mainnet") {
    return sendAndConfirmWithRetry(connection, tx, signers, {
      attempts: opts.attempts,
      confirmTimeoutMs: opts.confirmTimeoutMs,
      label: opts.label,
    });
  }

  const attempts = opts.attempts ?? 3;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 45_000;
  const label = opts.label ?? "tx";
  // Flat 5,000-lamport SWQOS-only tip (no DEFAULT_JITO_TIP_LAMPORTS clamp:
  // that floor is 0.001 SOL and would silently defeat the low-tip tier).
  const tipLamports = opts.tipLamports ?? HELIUS_SENDER_SWQOS_TIP_LAMPORTS;
  const tipPayer = signers[0];
  if (!tipPayer) throw new Error(`${label}: no signer to pay the tip`);
  const tipAccount = opts.tipAccount ?? pickSenderTipAccount();

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const latest = await connection.getLatestBlockhash("confirmed");

    // Build a fresh signed tx per attempt (the caller's tx is never mutated):
    // priority fee FIRST (unless the tx already carries one — the launch txs
    // built by lib/bundle/launch.ts do, and a second compute-unit-price ix
    // would be rejected), then the trade/launch instructions, then the Sender
    // tip LAST (the tip transfer must be the final instruction).
    const signed = new Transaction({
      feePayer: tx.feePayer as PublicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    if (!opts.skipPriorityFeeIx) {
      signed.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
        })
      );
    }
    signed.add(...tx.instructions);
    signed.add(
      SystemProgram.transfer({
        fromPubkey: tipPayer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      })
    );
    signed.sign(...signers);

    let signature: string;
    try {
      signature = await senderSend(signed.serialize().toString("base64"));
    } catch (e) {
      lastErr = e;
      if (isBlockhashExpiredError(errMsg(e)) && attempt + 1 < attempts) {
        await sleepMs(400);
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    try {
      const confirmed = await withTimeout(
        connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        ),
        confirmTimeoutMs,
        `${label} (${signature}) confirm timed out after ${confirmTimeoutMs}ms; the tx may still land`
      );
      if (confirmed.value.err) {
        throw new Error(
          `${label} (${signature}) failed on chain: ${JSON.stringify(
            confirmed.value.err
          )}`
        );
      }
      return { signature };
    } catch (e) {
      lastErr = e;
      const msg = errMsg(e);
      if (isBlockhashExpiredError(msg) && attempt + 1 < attempts) {
        await sleepMs(400);
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${label} failed after ${attempts} attempts`);
}

/**
 * Builds the send function for a batch. On mainnet it returns the
 * Helius-Sender-backed sender; on devnet it returns the plain
 * sendAndConfirmWithRetry. Resolve once per batch in the caller, pass the
 * result into each worker.
 */
export function makeProtectedSender(): SendTx {
  if (solanaNetwork() !== "mainnet") return sendAndConfirmWithRetry;
  return sendProtectedTx;
}
