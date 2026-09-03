// Milestone M7b: fan-out bundle submission with escalating tip, the Tier 2
// submission path for the launch panel. Drop-in for
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
// ESCALATION: same as submitWithRetry, re-assembly happens client-side with a
// fresh shared blockhash and tip * 2^attempt on every failed attempt, so the
// proxy stays stateless (it never holds a tip budget or a blockhash).
//
// STATUS POLLING: only Jito exposes an in-flight bundle status API. When the
// winning relay is Jito, status polls through the proxy (GET
// ?action=status&relay=jito&bundleId=...). When a non-Jito relay accepted
// (bloXroute/Astralane), there is no status API: the outcome is "pending"
// with an honest note and the caller's own on-chain verification (the mint
// appearing) is the ground truth, exactly the M7a rule that only a landed
// bundle is a launch.

import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { DEFAULT_JITO_TIP_LAMPORTS } from "../fees";
import { JitoBundleClient, MIN_TIP_LAMPORTS } from "./jito";
import {
  submitBundleViaRelayProxy,
  type RelayFanoutResult,
  type RelayId,
  summarizeFanout,
} from "./relays";
import type { BundleSubmissionResult, BundleAttempt } from "./jito";

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** True when the relay that accepted is status-pollable (Jito). */
function isPollableRelay(relay: RelayId): boolean {
  return relay === "jito";
}

/** Polls the winning Jito bundle's status through the proxy. Returns
 *  "timeout" when no final status arrives in the window. */
async function pollProxyStatus(
  bundleId: string,
  pollTimeoutMs: number,
  pollIntervalMs: number,
  fetchFn: typeof fetch
): Promise<{ status: string; landedSlot: number | null } | "timeout"> {
  const start = Date.now();
  for (;;) {
    try {
      const res = await fetchFn(
        `/api/bundle-relay?action=status&relay=jito&bundleId=${encodeURIComponent(bundleId)}`
      );
      const json = (await res.json()) as {
        status?: string | null;
        landedSlot?: number | null;
        error?: string;
      };
      if (res.ok && json.status) {
        if (json.status === "Landed" || json.status === "Failed" || json.status === "Invalid") {
          return { status: json.status, landedSlot: json.landedSlot ?? null };
        }
      }
    } catch {
      // transient proxy/RPC blip: keep polling until the window closes
    }
    if (Date.now() - start > pollTimeoutMs) return "timeout";
    await sleepMs(pollIntervalMs);
  }
}

export interface FanoutSubmitOptions {
  /** The unsigned bundle txs in execution order (fund?, create, buys). */
  txs: Transaction[];
  /** Signers per tx, aligned with txs. */
  signersByTx: Keypair[][];
  /** Pays the tip transfer (added to the LAST tx on assembly). */
  tipPayer: Keypair;
  tipAccount?: PublicKey;
  /** Initial tip in lamports (default lib/fees DEFAULT_JITO_TIP_LAMPORTS).
   *  Escalates 2x per failed attempt, same as submitWithRetry. */
  initialTipLamports?: number;
  maxAttempts?: number;
  pollTimeoutMs?: number;
  pollIntervalMs?: number;
  connection: Connection;
  onAttempt?: (a: BundleAttempt) => void;
  /** Override fetch (tests); defaults to the browser global. */
  fetchFn?: typeof fetch;
}

/**
 * Submits a launch bundle through the relay fan-out proxy with an escalating
 * tip. Returns the same BundleSubmissionResult as submitWithRetry so the
 * caller's honest reporting (bundleDropMessage, "BUNDLE DID NOT LAND") works
 * unchanged.
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
    const tipLamports = Math.max(MIN_TIP_LAMPORTS, initialTipLamports * 2 ** i);
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

    let base64: string[];
    try {
      const assembled = await assembler.assembleBundle({
        txs,
        signersByTx,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        tipAccount,
        tipLamports,
        tipPayer,
      });
      base64 = assembled.base64;
    } catch (e) {
      attempts.push({ attempt: i + 1, tipLamports, sendError: `assemble: ${errMsg(e)}` });
      break;
    }

    // Fan out through the same-origin proxy (Jito + bloXroute + Astralane in
    // parallel, first-accept-wins; credentials stay server-side).
    let fanout: RelayFanoutResult;
    try {
      fanout = await submitBundleViaRelayProxy({ base64, fetchFn });
    } catch (e) {
      attempts.push({ attempt: i + 1, tipLamports, sendError: `relay proxy: ${errMsg(e)}` });
      continue;
    }

    const winner = fanout.accepted;
    if (winner && winner.bundleId) {
      const attempt: BundleAttempt = {
        attempt: i + 1,
        tipLamports,
        bundleId: winner.bundleId,
        status: `accepted by ${winner.relay}`,
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
      const withStatus: BundleAttempt = { ...attempt, status: undefined, landedSlot: null };
      if (status !== "timeout") {
        withStatus.status = status.status;
        withStatus.landedSlot = status.landedSlot;
      }
      attempts[attempts.length - 1] = withStatus;

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
      // Invalid / Failed: escalate the tip and re-submit (next loop).
      continue;
    }

    // No relay accepted this attempt.
    attempts.push({
      attempt: i + 1,
      tipLamports,
      sendError: fanout.legs.length
        ? `no relay accepted (${summarizeFanout(fanout)})`
        : "no relay accepted (all disabled/skipped)",
    });
    if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
  }
  return { outcome: "rejected", attempts, note: "all attempts rejected or failed to land" };
}
