// Tier 2 atomic bundle submission at the configured tip (no tip escalation),
// through the same-origin relay proxy (app/api/bundle-relay/route.ts).
//
// RELAY MODEL (2026-09-06): NextBlock is the PRIMARY Tier 2 relay and
// Astralane Iris / bloXroute are OPTIONAL fallbacks. Every relay only
// recognizes ITS OWN tip accounts, so a NextBlock-tipped bundle cannot be
// shared: this submitter assembles a PROVIDER-SPECIFIC signed bundle per
// target relay — each with
// that relay's recognized tip account (official Astralane `astra...` /
// bloXroute `bLx...`/`3UQU...` constants in lib/bundle/relays.ts) in the
// LAST tx — and POSTs the variants to the same-origin proxy, which submits
// them SEQUENTIALLY (NextBlock first; Astralane/bloXroute only on an
// explicit reject / unreachable). Jito is a legacy compatibility relay and is NOT part of the
// active order; the only Jito-specific machinery left here is the status
// poll for a legacy jito winner.
//
// WHY THE PROXY: bloXroute needs a JWT and Astralane needs an API key, both
// server-side secrets that must never reach the browser bundle. The browser
// assembles and signs every provider variant locally (no key material leaves
// the page) and POSTs the base64 txs to its own origin; the route attaches
// the relay credentials and submits in order (the v4 flashbots-proxy
// pattern). Wallet secrets stay in the browser; only signed base64
// transactions cross the same-origin proxy.
//
// SAFE RETRIES: each attempt uses a fresh blockhash at the same configured
// tip. Atomic create semantics make this safe: if an earlier bundle lands, a
// later one fails at create and cannot reach the tip instruction.
//
// HONEST OUTCOMES (M7a rule: only a LANDED bundle is a launch):
//   - Astralane / bloXroute accepted: they expose NO bundle status API, so
//     the result is "pending" with an honest note — the caller's own
//     on-chain verification (the mint appearing) is the ground truth. We do
//     NOT fabricate a relay status API.
//   - Jito winner (legacy path only): status polls through the proxy (GET
//     ?action=status&relay=jito&bundleId=...), which merges the coarse
//     getInflightBundleStatuses verdict with getBundleStatuses'
//     rejection_reason, and this module surfaces it on the attempt + in the
//     final note while the detailed status is still available.
//   - Nothing accepted: "rejected"/"unreachable" with per-attempt detail.

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
  defaultTipAccountForRelay,
  RELAY_MIN_TIP_LAMPORTS,
  RELAY_ORDER,
  type RelayFanoutResult,
  type RelayId,
  summarizeFanout,
} from "./relays";
import type {
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

/** True when the relay that accepted is status-pollable (Jito only — the
 *  active Tier 2 relays expose no bundle status API). */
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

/** One assembled provider-specific variant: signed txs + their base64 + the
 *  relay tip account they pay. */
export interface RelayVariant {
  base64: string[];
  tipAccount: string;
  signedTxs: Transaction[];
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
 * Polls the winning Jito bundle's status through the proxy (legacy path).
 * Returns "timeout" when no final status arrives in the window.
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
  /** Tip account override for the JITO legacy leg only; the active Tier 2
   *  relays use their own official tip accounts (see relays.ts
   *  defaultTipAccountForRelay), never this value. */
  tipAccount?: PublicKey;
  /** Tip in lamports for the submission attempt (default lib/fees
   *  DEFAULT_JITO_TIP_LAMPORTS = 0.001 SOL, the Astralane/bloXroute floor).
   *  Used as-is; no escalation. */
  initialTipLamports?: number;
  /** Relays to assemble provider-specific variants for and submit, in order
   *  (default RELAY_ORDER: nextblock primary, astralane/bloxroute fallback). */
  relays?: RelayId[];
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
 * Assembles one PROVIDER-SPECIFIC signed bundle variant per target relay.
 * Every variant is built from the same unsigned launch txs with THAT relay's
 * recognized tip account in the final tx, so the exact same Jito-tipped
 * bundle is never reused across relays (each relay sees only its own
 * variant). A tip below a relay's minimum is a hard error (retrying at the
 * same sub-floor tip cannot succeed).
 */
export async function assembleRelayVariants(opts: {
  txs: Transaction[];
  signersByTx: Keypair[][];
  blockhash: string;
  lastValidBlockHeight: number;
  tipLamports: number;
  tipPayer: Keypair;
  relays?: RelayId[];
  jitoTipAccount?: PublicKey;
  assembler?: JitoBundleClient;
}): Promise<{ variants: Partial<Record<RelayId, RelayVariant>> }> {
  const {
    txs,
    signersByTx,
    blockhash,
    lastValidBlockHeight,
    tipLamports,
    tipPayer,
    relays = RELAY_ORDER,
    jitoTipAccount,
    assembler = new JitoBundleClient("https://mainnet.block-engine.jito.wtf/api/v1"),
  } = opts;
  const variants: Partial<Record<RelayId, RelayVariant>> = {};
  for (const relay of relays) {
    // The active Tier 2 relays (astralane/bloxroute) pay their OWN official
    // tip accounts; jito (legacy) honors the caller's override or the
    // well-known first account (a live block-engine pick happens in the
    // submit loop for the legacy path).
    const tipAccount =
      relay === "jito" && jitoTipAccount
        ? jitoTipAccount
        : new PublicKey(defaultTipAccountForRelay(relay));
    const floor = RELAY_MIN_TIP_LAMPORTS[relay];
    if (tipLamports < floor) {
      throw new Error(
        `tip ${tipLamports} lamports below ${relay}'s ${floor}-lamport (0.001 SOL) minimum`
      );
    }
    const assembly = await assembler.assembleBundle({
      txs,
      signersByTx,
      blockhash,
      lastValidBlockHeight,
      tipAccount,
      tipLamports,
      tipPayer,
    });
    variants[relay] = {
      base64: assembly.base64,
      tipAccount: tipAccount.toBase58(),
      signedTxs: assembly.signedTxs,
    };
  }
  return { variants };
}

/**
 * Submits a launch bundle through the relay proxy: assembles a
 * provider-specific signed bundle per target relay (NextBlock primary,
 * Astralane/bloXroute fallback — each paying its own recognized tip account)
 * and lets
 * the proxy submit them SEQUENTIALLY. Dropped/failed bundles are retried
 * with a fresh blockhash at the same configured tip. Returns the same
 * BundleSubmissionResult as submitWithRetry so the caller's honest reporting
 * (bundleDropMessage, "BUNDLE DID NOT LAND") works unchanged.
 */
export async function submitBundleViaFanoutWithRetry(
  opts: FanoutSubmitOptions
): Promise<BundleSubmissionResult> {
  const { txs, signersByTx, tipPayer, connection } = opts;
  const relays = opts.relays ?? RELAY_ORDER;
  const initialTipLamports = opts.initialTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS;
  const maxAttempts = opts.maxAttempts ?? 3;
  const pollTimeoutMs = opts.pollTimeoutMs ?? 40_000;
  const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
  const fetchFn =
    opts.fetchFn ?? (globalThis as { fetch: typeof fetch }).fetch;
  const attempts: BundleAttempt[] = [];
  // Network-touching only for the legacy jito leg (live tip-account pick);
  // assembleBundle itself is pure and needs no endpoint.
  const assembler = new JitoBundleClient("https://mainnet.block-engine.jito.wtf/api/v1");
  // The relay whose variant is the diagnostic "bundle b64" canonical:
  // astralane when present, else the first attempted relay.
  const canonicalRelay = relays.includes("astralane") ? "astralane" : relays[0];

  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) await sleepMs(RETRY_DELAY_MS);
    const tipLamports = Math.max(MIN_TIP_LAMPORTS, initialTipLamports);

    // jito legacy leg: pick a live tip account once when the caller did not
    // pin one (active Tier 2 relays need no network: official constants).
    let jitoLiveTip: PublicKey | undefined = opts.tipAccount;
    if (relays.includes("jito") && !jitoLiveTip) {
      try {
        jitoLiveTip = new PublicKey(await assembler.pickTipAccount());
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

    let variants: Partial<Record<RelayId, RelayVariant>>;
    try {
      const assembled = await assembleRelayVariants({
        txs,
        signersByTx,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
        tipLamports,
        tipPayer,
        relays,
        jitoTipAccount: jitoLiveTip,
        assembler,
      });
      variants = assembled.variants;
    } catch (e) {
      // e.g. a tip below a relay's minimum: fail the attempt fast (retrying
      // at the same sub-floor tip cannot succeed).
      attempts.push({ attempt: i + 1, tipLamports, sendError: `assemble: ${errMsg(e)}` });
      if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
      break;
    }

    const canonical: RelayVariant | undefined = variants[canonicalRelay] ?? variants[relays[0]];
    // Per-attempt diagnostic context, carried onto every attempt so a
    // rejected bundle leaves enough behind to decode the exact signed txs.
    const attemptContext = {
      blockhash: latest.blockhash,
      lastValidBlockHeight: latest.lastValidBlockHeight,
      txSignatures: canonical ? bundleTxSignatures(canonical.signedTxs) : [],
      base64: canonical?.base64 ?? [],
    };

    // Submit sequentially through the same-origin proxy (NextBlock primary,
    // Astralane/bloXroute fallback on explicit reject/unreachable;
    // credentials stay server-side). Only the provider-specific base64
    // variants cross the proxy.
    const bundles: Partial<Record<RelayId, string[]>> = {};
    for (const [relay, variant] of Object.entries(variants) as [RelayId, RelayVariant][]) {
      bundles[relay] = variant.base64;
    }
    let fanout: RelayFanoutResult;
    try {
      fanout = await submitBundleViaRelayProxy({ bundles, relays, fetchFn });
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
        // Astralane/bloXroute expose no status API; the caller's on-chain
        // verification is the ground truth for landing.
        const tipAcct = variants[winner.relay]?.tipAccount ?? "n/a";
        return {
          outcome: "pending",
          bundleId: winner.bundleId,
          attempts,
          note: `${winner.relay} accepted the bundle (${summarizeFanout(fanout)}; tip -> ${tipAcct}); no relay status API exists — on-chain verification (the mint appearing) decides landing`,
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
      // Invalid / Failed (legacy jito winner): emit the full diagnostic and
      // retry on the next loop.
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
