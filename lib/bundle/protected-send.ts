// Front-running-protected single-tx send for the MANUAL + AUTO buy/sell
// engines (lib/batch-trade.ts and lib/auto.ts), via Helius Sender Max
// (sender.helius-rpc.com/fast).
//
// WHY HELIUS SENDER (not Jito): the earlier Jito single-tx bundle path
// (client.sendBundle to the block engine) kept coming back "accepted then
// Invalid" — the same drop the repo already documented for the launch flow,
// which is why Jito was demoted there. Helius Sender is a plain sendTransaction
// to a low-latency endpoint that routes across all high-speed pathways
// (Helius/Jito/Harmonic/Rakurai) and returns the TX SIGNATURE directly, so
// there is no bundle id and no status polling to mis-handle.
//
// On MAINNET each wallet's buy/sell is submitted to Helius Sender with:
//   1. a priority fee (setComputeUnitPrice) — REQUIRED, and the buy/sell txs
//      otherwise carry none, which was also hurting landing on the Jito path;
//   2. the trade instructions;
//   3. a >= 0.001 SOL tip transfer to a Helius Sender tip account (LAST).
// ?mev-protect=true on the endpoint routes around validators statistically
// linked to sandwich attacks — this is the front-running protection that
// replaces the old Jito bundle. Drop the query param to maximize inclusion
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
import {
  DEFAULT_JITO_TIP_LAMPORTS,
  DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
} from "../fees";
import { solanaNetwork } from "../network";
import { isBlockhashExpiredError } from "../tx-errors";
import { sendAndConfirmWithRetry, withTimeout } from "./launch";

/** Helius Sender Max endpoint. ?mev-protect=true routes around validators
 *  statistically linked to sandwich attacks (front-running protection). */
export const HELIUS_SENDER_URL =
  "https://sender.helius-rpc.com/fast?mev-protect=true";

/** Helius Sender tip accounts: the SOL transfer that pays for priority
 *  landing. Sender Max requires >= 0.001 SOL. Source:
 *  helius.dev/docs/sending-transactions/sender-max (the documented list). */
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

/** Sender Max minimum tip (0.001 SOL), lamports. */
const HELIUS_SENDER_MIN_TIP_LAMPORTS = 1_000_000;

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
  /** Tip in lamports; default DEFAULT_JITO_TIP_LAMPORTS clamped to the Sender
   *  Max floor (0.001 SOL). */
  tipLamports?: number;
  /** Pre-resolved tip account; defaults to a random Helius Sender account. */
  tipAccount?: PublicKey;
}

/** The Sender tip (lamports) actually paid on mainnet, 0 on devnet. */
export function protectedTipLamports(): number {
  if (solanaNetwork() !== "mainnet") return 0;
  return Math.max(HELIUS_SENDER_MIN_TIP_LAMPORTS, DEFAULT_JITO_TIP_LAMPORTS);
}

/** The priority fee (lamports) a mainnet buy/sell pays, 0 on devnet. Estimated
 *  as the configured micro-lamports/CU price times a ~250k-CU trade (the
 *  measured pump.fun buy ceiling). */
export function protectedPriorityFeeReserve(): number {
  if (solanaNetwork() !== "mainnet") return 0;
  return Math.round((DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS * 250_000) / 1_000_000);
}

/** Total extra lamports a MAINNET buy must reserve above the fee/rent floor:
 *  the Sender tip + the priority fee. 0 on devnet. The buy's spendable-SOL
 *  formulas subtract this so a buy never quotes an amount it cannot cover. */
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
 * Max (priority fee + tip, mev-protect) confirmed on-chain by signature.
 * Devnet: plain sendAndConfirmWithRetry (no block engine).
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
  const tipLamports = Math.max(
    HELIUS_SENDER_MIN_TIP_LAMPORTS,
    opts.tipLamports ?? DEFAULT_JITO_TIP_LAMPORTS
  );
  const tipPayer = signers[0];
  if (!tipPayer) throw new Error(`${label}: no signer to pay the tip`);
  const tipAccount = opts.tipAccount ?? pickSenderTipAccount();

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const latest = await connection.getLatestBlockhash("confirmed");

    // Build a fresh signed tx per attempt (the caller's tx is never mutated):
    // priority fee FIRST, then the trade instructions, then the Sender tip
    // LAST (the tip transfer must be the final instruction).
    const signed = new Transaction({
      feePayer: tx.feePayer as PublicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    signed.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
      })
    );
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
