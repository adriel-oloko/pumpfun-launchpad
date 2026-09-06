// Milestone M7b: fan-out bundle submission at the configured tip (no tip
// escalation), the Tier 2 submission path for the
// launch panel. Drop-in for
// JitoBundleClient.submitWithRetry: SAME BundleSubmissionResult shape and
// SAME honest semantics (only a LANDED bundle is a launch; everything else
// reports rejected/pending/unreachable with per-attempt detail), but the
// bundle is submitted through the SAME-ORIGIN relay proxy
// (/api/bundle-relay, app/api/bundle-relay/route.ts) which fans it out to
// Jito (primary) + bloXroute + Astralane in parallel, first-accept-wins.
//
// WHY THE PROXY: bloXroute needs a JWT and Astralane needs an API key, both
// server-side secrets that must never reach the browser bundle. The browser
// assembles and signs the bundle locally (no key material leaves the page)
// and POSTs the base64 txs to its own origin; the route attaches the relay
// credentials and fans out (the v4 flashbots-proxy pattern).
//
// SAFE RETRIES: Jito's official status documentation defines Invalid as "no
// longer in the system", not "simulation failed". It can also appear briefly
// before a new bundle propagates to the status service. We apply a short grace
// window, then retry a dropped bundle with a fresh blockhash at the same tip.
// Atomic create semantics make this safe: if an earlier bundle lands, a later
// one fails at create and cannot reach the tip instruction.
//
// STATUS POLLING: only Jito exposes an in-flight bundle status API. When the
// winning relay is Jito, status polls through the proxy (GET
// ?action=status&relay=jito&bundleId=...). The proxy merges the coarse
// getInflightBundleStatuses verdict with getBundleStatuses' rejection_reason
// (TransactionFailure / ExceedsCostModel / BlockhashNotFound / TipError / ...),
// and this module surfaces it on the attempt + in the final note, so a
// rejected bundle logs WHY it was rejected while the detailed status is still
// available (it ages out in seconds). When a non-Jito
// relay accepted (bloXroute/Astralane), there is no status API: the outcome is
// "pending" with an honest note and the caller's own on-chain verification
// (the mint appearing) is the ground truth, exactly the M7a rule that only a
// landed bundle is a launch.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { DEFAULT_JITO_TIP_LAMPORTS } from "../fees";
import {
  JitoBundleClient,
  MIN_TIP_LAMPORTS,
  shouldFinalizeInvalidStatus,
} from "./jito";
import {
  submitBundleViaRelayProxy,
  type RelayFanoutResult,
  type RelayId,
  summarizeFanout,
} from "./relays";
import type {
  BundleAssembly,
  BundleAttempt,
  BundleSubmissionResult,
} from "./jito";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

const RETRY_DELAY_MS = 1_200;

/** True when the relay that accepted is status-pollable (Jito). */
function isPollableRelay(relay: RelayId): boolean {
  return relay === "jito";
}

/** Base58 canonical (fee-payer) signature of each signed bundle tx, aligned
 *  1:1 with the signed txs. When a bundle is Invalid nothing lands, so these
 *  are identifiers that let a post-mortem correlate the exact signed txs. */
function bundleTxSignatures(signedTxs: Transaction[]): string[] {
  return signedTxs.map((tx) => {
    const feePayer = tx.feePayer as PublicKey | null;
    const feeSig = tx.signatures.find(
      (s) => feePayer !== null && s.publicKey.equals(feePayer)
    );
    return feeSig?.signature ? bs58.encode(feeSig.signature) : "";
  });
}

interface ProxyStatusPoll {
  status: string;
  landedSlot: number | null;
  rejectionReason?: string | null;
  rejectionMsg?: string | null;
}

/** One status GET through the proxy. Returns null on a transient error or an
 *  empty verdict so the caller can re-query (never throws). The proxy route's
 *  GET handler polls BOTH getInflightBundleStatuses (coarse lifecycle) and
 *  getBundleStatuses (the ACTUAL rejection_reason) and merges them, so a
 *  single call can carry the reason. */
async function fetchProxyStatusOnce(
  bundleId: string,
  fetchFn: typeof fetch
): Promise<ProxyStatusPoll | null> {
  try {
    const res = await fetchFn(
      `/api/bundle-relay?action=status&relay=jito&bundleId=${encodeURIComponent(bundleId)}`
    );
    const json = (await res.json()) as {
      status?: string | null;
      landedSlot?: number | null;
      rejectionReason?: string | null;
      rejectionMsg?: string | null;
      error?: string;
    };
    if (res.ok && json.status) {
      return {
        status: json.status,
        landedSlot: json.landedSlot ?? null,
        rejectionReason: json.rejectionReason ?? null,
        rejectionMsg: json.rejectionMsg ?? null,
      };
    }
  } catch {
    // transient proxy/RPC blip: the caller retries
  }
  return null;
}

/**
 * Polls the winning Jito bundle's status through the proxy. Returns "timeout"
 * when no final status arrives in the window.
 *
 * getInflightBundleStatuses can report Failed/Invalid a beat before
 * getBundleStatuses populates rejection_reason, and the detailed status ages
 * out in seconds. So once a final Failed/Invalid verdict arrives without a
 * reason, re-query TIGHTLY (sub-second) before giving up; never after a full
 * poll-interval sleep, or the rejection reason is lost for good.
 */
async function pollProxyStatus(
  bundleId: string,
  pollTimeoutMs: number,
  pollIntervalMs: number,
  fetchFn: typeof fetch
): Promise<ProxyStatusPoll | "timeout"> {
  const start = Date.now();
  let invalidObservations = 0;
  for (;;) {
    const polled = await fetchProxyStatusOnce(bundleId, fetchFn);
    if (polled) {
      const isFinal =
        polled.status === "Landed" ||
        polled.status === "Failed" ||
        polled.status === "Invalid";
      if (isFinal) {
        if (
          (polled.status === "Failed" || polled.status === "Invalid") &&
          !polled.rejectionReason
        ) {
          const detailed = await tightRetryDetailedStatus(bundleId, fetchFn);
          if (detailed) return detailed;
        }
        if (polled.status === "Invalid" && !polled.rejectionReason) {
          invalidObservations += 1;
          if (!shouldFinalizeInvalidStatus(invalidObservations, Date.now() - start, false)) {
            await sleepMs(Math.min(pollIntervalMs, 600));
            continue;
          }
        }
        return polled;
      }
      invalidObservations = 0;
    }
    if (Date.now() - start > pollTimeoutMs) return "timeout";
    await sleepMs(pollIntervalMs);
  }
}

/** A few sub-second re-queries to catch getBundleStatuses' rejection reason
 *  before it ages out (it lags the coarse in-flight verdict). Returns the
 *  first poll carrying a reason; otherwise null (caller keeps the coarse
 *  verdict with rejectionReason null). */
async function tightRetryDetailedStatus(
  bundleId: string,
  fetchFn: typeof fetch,
  attempts = 4,
  delayMs = 600
): Promise<ProxyStatusPoll | null> {
  for (let i = 0; i < attempts; i++) {
    await sleepMs(delayMs);
    const polled = await fetchProxyStatusOnce(bundleId, fetchFn);
    if (!polled) continue;
    if (polled.rejectionReason || polled.status === "Landed") return polled;
  }
  return null;
}

export interface FanoutSubmitOptions {
  /** The unsigned bundle txs in execution order (fund?, create, buys). */
  txs: Transaction[];
  /** Signers per tx, aligned with txs. */
  signersByTx: Keypair[][];
  /** Pays the tip transfer (added to the LAST tx on assembly). */
  tipPayer: Keypair;
  tipAccount?: PublicKey;
  /** Tip in lamports for the submission attempt (default lib/fees
   *  DEFAULT_JITO_TIP_LAMPORTS). Used as-is; no escalation. */
  initialTipLamports?: number;
  /** Max submission attempts (default 3). Dropped/failed attempts use a fresh
   *  blockhash at the same configured tip. */
  maxAttempts?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  connection: Connection;
  onAttempt?: (a: BundleAttempt) => void;
  /** Override fetch (tests); defaults to the browser global. */
  fetchFn?: typeof fetch;
}

/**
 * Submits a launch bundle through the relay fan-out proxy. Dropped/failed
 * bundles are retried with a fresh blockhash at the same configured tip. Returns the same
 * BundleSubmissionResult as submitWithRetry so the caller's honest reporting
 * (bundleDropMessage, "BUNDLE DID NOT LAND") works unchanged.
 */
export async function submitBundleViaFanoutWithRetry(
  opts: FanoutSubmitOptions
): Promise<BundleSubmissionResult> {
  const { txs, signersByTx, tipPayer, connection } = opts;
  const initialTipLamports = opts.initialTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS;
  const maxAttempts = opts.maxAttempts ?? 3;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 40_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
  const fetchFn =
    opts.fetchFn ?? (globalThis as { fetch: typeof fetch }).fetch;
  let tipAccount = opts.tipAccount;
  const attempts: BundleAttempt[] = [];

  // Assembly is relay-agnostic (the Jito client assembles the shared
  // blockhash + tip-last convention that every relay accepts).
  const assembler = new JitoBundleClient("https://mainnet.block-engine.jito.wtf/api/v1");

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleepMs(RETRY_DELAY_MS);
    const tipLamports = Math.max(MIN_TIP_LAMPORTS, initialTipLamports);
    if (!tipAccount) {
      try {
        tipAccount = new PublicKey(await assembler.pickTipAccount());
      } catch (e) {
        attempts.push({
          attempt: i + 1,
          tipLamports,
          sendError: `tip accounts: ${errMsg(e)}`,
        });
        if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
        continue;
      }
    }

    let latest: { blockhash: string; lastValidBlockHeight: number };
    try {
      latest = await connection.getLatestBlockhash("confirmed");
    } catch (e) {
      attempts.push({ attempt: i + 1, tipLamports, sendError: `blockhash: ${errMsg(e)}` });
      if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
      continue;
    }

    let assembled: BundleAssembly;
    try {
      assembled = await assembler.assembleBundle({
        txs,
        signersByTx,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        tipAccount,
        tipLamports,
        tipPayer,
      });
    } catch (e) {
      attempts.push({ attempt: i + 1, tipLamports, sendError: `assemble: ${errMsg(e)}` });
      if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
      break;
    }

    // Per-attempt diagnostic context, carried onto every attempt so a
    // rejected bundle leaves enough behind to decode the exact signed txs.
    const attemptContext = {
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      txSignatures: bundleTxSignatures(assembled.signedTxs),
      base64: assembled.base64,
    };

    // Fan out through the same-origin proxy (Jito + bloXroute + Astralane in
    // parallel, first-accept-wins; credentials stay server-side).
    let fanout: RelayFanoutResult;
    try {
      fanout = await submitBundleViaRelayProxy({ base64: assembled.base64, fetchFn });
    } catch (e) {
      attempts.push({
        attempt: i + 1,
        tipLamports,
        sendError: `relay proxy: ${errMsg(e)}`,
        ...attemptContext,
      });
      if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
      continue;
    }

    const winner = fanout.accepted;
    if (winner && winner.bundleId) {
      const attempt: BundleAttempt = {
        attempt: i + 1,
        tipLamports,
        bundleId: winner.bundleId,
        status: `accepted by ${winner.relay}`,
        winningRelay: winner.relay,
        ...attemptContext,
      };
      attempts.push(attempt);
      if (opts.onAttempt) opts.onAttempt(attempt);

      if (!isPollableRelay(winner.relay)) {
        // bloXroute/Astralane expose no status API; the caller's on-chain
        // verification is the ground truth for landing.
        return {
          outcome: "pending",
          bundleId: winner.bundleId,
          attempts,
          note: `${winner.relay} accepted the bundle (${summarizeFanout(fanout)}); no relay status API exists, on-chain verification decides landing`,
        };
      }

      const status = await pollProxyStatus(winner.bundleId, pollTimeoutMs, pollIntervalMs, fetchFn);
      const finalAttempt: BundleAttempt = { ...attempt, status: undefined, landedSlot: null };
      if (status !== "timeout") {
        finalAttempt.status = status.status;
        finalAttempt.landedSlot = status.landedSlot;
        // Surface the ACTUAL rejection reason (BlockhashNotFound,
        // TransactionFailure, ExceedsCostModel, ...) so a rejected bundle is
        // diagnosable instead of reporting the opaque "Invalid" alone.
        finalAttempt.rejectionReason = status.rejectionReason ?? null;
        finalAttempt.rejectionMsg = status.rejectionMsg ?? null;
      }
      attempts[attempts.length - 1] = finalAttempt;

      if (status === "timeout") {
        return {
          outcome: "pending",
          bundleId: winner.bundleId,
          attempts,
          note: "no final status within the poll window; the bundle may still land",
        };
      }
      if (status.status === "Landed") {
        return { outcome: "landed", bundleId: winner.bundleId, landedSlot: status.landedSlot, attempts };
      }
      // Invalid / Failed: emit the full diagnostic (bundle id, verdict,
      // rejection reason + message, blockhash, height, tip, tx signatures)
      // so the caller logs the why while the details are still in hand. The
      // rejection reason comes from getBundleStatuses, which the proxy
      // route's GET handler merges with the coarse in-flight verdict (it is
      // NOT opaque; see app/api/bundle-relay/route.ts). Invalid means the
      // bundle is gone from Jito's system, and Failed means all regions failed
      // before forwarding, so either verdict is safe to retry.
      if (opts.onAttempt) opts.onAttempt(finalAttempt);
      continue;
    }

    // No relay accepted this attempt.
    attempts.push({
      attempt: i + 1,
      tipLamports,
      sendError: fanout.legs.length
        ? summarizeFanout(fanout)
        : "no relay accepted (all disabled/skipped)",
      ...attemptContext,
    });
    if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
  }
  // Rejected: fold the last rejection reason into the note so the caller's
  // bundleDropMessage carries the why without needing to dig through attempts.
  const lastAttempt = attempts[attempts.length - 1];
  const lastReason =
    lastAttempt?.rejectionReason
      ? ` last rejection: ${lastAttempt.rejectionReason}${
          lastAttempt.rejectionMsg ? ` (${lastAttempt.rejectionMsg})` : ""
        }`
      : "";
  return {
    outcome: "rejected",
    attempts,
    note: `all attempts rejected or failed to land${lastReason}`,
  };
}
