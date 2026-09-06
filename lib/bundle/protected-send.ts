// Front-running-protected single-tx send for the MANUAL + AUTO buy/sell
// engines (lib/batch-trade.ts and lib/auto.ts).
//
// On MAINNET, each wallet's buy/sell is submitted as a 1-tx Jito bundle
// instead of the open mempool: the tx is hidden from sandwich bots and pays a
// tip (a plain SOL transfer to a Jito tip account, appended as the LAST and
// only instruction). On DEVNET the Jito block engine is dead, so it falls
// back to the normal raw-RPC send (sendAndConfirmWithRetry) unchanged.
//
// Why not reuse JitoBundleClient.submitWithRetry directly: that path polls the
// coarse bundle status and returns a bundle id, but the buy/sell callers need
// the TX SIGNATURE (the trade report lists confirmed signatures). So this
// module drives the same primitives (sendBundle + getInFlightBundleStatuses
// via pollUntilFinal) while confirming on-chain by signature and returning
// { signature } exactly like sendAndConfirmWithRetry does.
//
// Failure semantics mirror sendAndConfirmWithRetry (lib/bundle/launch.ts):
//   - An expired blockhash (or a Jito "Invalid" drop, the documented
//     blockhash/block-engine-layer cause) is re-submitted with a FRESH
//     blockhash, which is safe because an expired/dropped tx can never land.
//   - A confirm timeout or an on-chain revert is surfaced, never silently
//     re-fired (a timed-out tx may still land; re-sending could double a buy).

import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { DEFAULT_JITO_TIP_LAMPORTS } from "../fees";
import { solanaNetwork } from "../network";
import { isBlockhashExpiredError } from "../tx-errors";
import { sendAndConfirmWithRetry, withTimeout } from "./launch";
import {
  JITO_MAINNET_ENDPOINT,
  JitoBundleClient,
  KNOWN_TIP_ACCOUNTS,
  MIN_TIP_LAMPORTS,
} from "./jito";

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
  /** Bounded window for the Jito inflight-status pre-check (fast Invalid/
   *  Landed detection) before falling back to on-chain confirm by signature. */
  pollTimeoutMs?: number;
  label?: string;
  /** Tip in lamports; default lib/fees.ts DEFAULT_JITO_TIP_LAMPORTS. */
  tipLamports?: number;
  /** Pre-resolved tip account (skip the live getTipAccounts call). */
  tipAccount?: PublicKey;
  /** Shared Jito client (reuse across a concurrent batch). */
  jitoClient?: JitoBundleClient;
}

/**
 * Sends ONE signed tx with front-running protection. Mainnet: 1-tx Jito
 * bundle (tip appended, hidden from the mempool) confirmed on-chain by
 * signature. Devnet: plain sendAndConfirmWithRetry (no block engine).
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
  const pollTimeoutMs = opts.pollTimeoutMs ?? 12_000;
  const label = opts.label ?? "tx";
  const tipLamports = Math.max(
    MIN_TIP_LAMPORTS,
    opts.tipLamports ?? DEFAULT_JITO_TIP_LAMPORTS
  );
  const client = opts.jitoClient ?? new JitoBundleClient(JITO_MAINNET_ENDPOINT);
  const tipPayer = signers[0];
  if (!tipPayer) throw new Error(`${label}: no signer to pay the tip`);

  let tipAccount = opts.tipAccount;
  if (!tipAccount) {
    try {
      tipAccount = new PublicKey(await client.pickTipAccount());
    } catch {
      tipAccount = new PublicKey(KNOWN_TIP_ACCOUNTS[0]);
    }
  }

  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const latest = await connection.getLatestBlockhash("confirmed");

    // Build a fresh signed tx per attempt (the caller's tx is never mutated)
    // with the tip transfer appended as the last instruction.
    const signed = new Transaction({
      feePayer: tx.feePayer as PublicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
    });
    signed.add(...tx.instructions);
    signed.add(
      SystemProgram.transfer({
        fromPubkey: tipPayer.publicKey,
        toPubkey: tipAccount,
        lamports: tipLamports,
      })
    );
    signed.sign(...signers);
    const sigBuf = signed.signature;
    if (!sigBuf) throw new Error(`${label}: signing produced no signature`);
    const signature = bs58.encode(sigBuf);

    let bundleId: string;
    try {
      bundleId = await client.sendBundle([
        signed.serialize().toString("base64"),
      ]);
    } catch (e) {
      lastErr = e;
      if (isBlockhashExpiredError(errMsg(e)) && attempt + 1 < attempts) {
        await sleepMs(400);
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    // Pre-check the coarse bundle status so a fast drop (Invalid/Failed) is
    // caught before spending the full confirm window. Landed returns at once.
    const status = await client.pollUntilFinal(bundleId, pollTimeoutMs, 1_500);
    if (status !== "timeout") {
      if (status.status === "Landed") return { signature };
      if (status.status === "Failed") {
        throw new Error(
          `${label}: jito bundle Failed (${bundleId}); the trade did not land`
        );
      }
      // Invalid = "no longer in the system", documented as a blockhash/
      // block-engine-layer drop (not a tx revert): re-submit fresh.
      lastErr = new Error(
        `${label}: jito bundle Invalid (${bundleId}); re-submitting with a fresh blockhash`
      );
      if (attempt + 1 < attempts) {
        await sleepMs(400);
        continue;
      }
      throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
    }

    // Status unknown within the pre-check window (or still confirming):
    // resolve by signature on-chain. A timeout here is surfaced, never
    // re-fired (the tx may still land).
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
 * The lamports a MAINNET buy must additionally reserve above the fee reserve
 * to cover the Jito tip (0 on devnet, where no tip is paid). Mirrors the tip
 * sendProtectedTx actually pays (DEFAULT_JITO_TIP_LAMPORTS clamped to the Jito
 * minimum), so the spendable-SOL formulas in batch-trade.ts and auto.ts can
 * subtract it and never quote a buy that cannot cover the tip.
 */
export function protectedTipReserve(): number {
  if (solanaNetwork() !== "mainnet") return 0;
  return Math.max(MIN_TIP_LAMPORTS, DEFAULT_JITO_TIP_LAMPORTS);
}

/**
 * Builds the send function for a batch. On mainnet it resolves ONE Jito client
 * + tip account (shared across the whole concurrent batch, so N wallets do not
 * each hammer getTipAccounts) and returns a Jito-backed sender; on devnet it
 * returns the plain sendAndConfirmWithRetry. Resolve once per batch in the
 * caller, pass the result into each worker.
 */
export async function makeProtectedSender(): Promise<SendTx> {
  if (solanaNetwork() !== "mainnet") {
    return sendAndConfirmWithRetry;
  }
  const client = new JitoBundleClient(JITO_MAINNET_ENDPOINT);
  let tipAccount: PublicKey;
  try {
    tipAccount = new PublicKey(await client.pickTipAccount());
  } catch {
    tipAccount = new PublicKey(KNOWN_TIP_ACCOUNTS[0]);
  }
  return (connection, tx, signers, opts = {}) =>
    sendProtectedTx(connection, tx, signers, {
      ...opts,
      jitoClient: client,
      tipAccount,
    });
}
