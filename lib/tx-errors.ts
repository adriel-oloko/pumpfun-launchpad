// Milestone M7a: friendly error classification for every Solana tx path.
//
// Central matchers shared by lib/bundle, lib/auto, lib/sell-all and the
// panels. Every matcher runs on the RAW error message string. Callers use
// these to decide retry-vs-surface (isBlockhashExpiredError etc.) and to
// convert a raw message into something a non-expert can act on
// (friendlyTxError). Keep the regexes stable: retry logic depends on them.

/** True when the message says the recent blockhash died before the tx landed.
 *  These errors are always retryable with a fresh blockhash because an
 *  expired-blockhash tx can never land afterwards. */
export function isBlockhashExpiredError(msg: string): boolean {
  return /blockhash ?not ?found|BlockhashNotFound|blockhash.*expired|expired blockhash|TransactionExpiredBlockheightExceeded|TransactionExpiredTimeout|simulation failed.*blockhash/i.test(
    msg
  );
}

/** True for RPC rate-limit / throttling / pool-exhaustion conditions. */
export function isRateLimitError(msg: string): boolean {
  return /429|408|too many requests|rate ?limit|quota|pool exhausted|rpc pool exhausted/i.test(
    msg
  );
}

/** True when the paying wallet lacks the lamports for the tx. */
export function isInsufficientFundsError(msg: string): boolean {
  return /insufficient funds|insufficient lamports|not enough lamports/i.test(
    msg
  );
}

/** True when a wallet would end below the rent-exempt floor. */
export function isRentError(msg: string): boolean {
  return /insufficient lamports for rent|rent-exempt|InsufficientFundsForRent|below rent/i.test(
    msg
  );
}

/** True when the tx executed and reverted on chain (deterministic: re-sending
 *  with a fresh blockhash cannot change the outcome). */
export function isOnChainRevert(msg: string): boolean {
  return /instructionerror|failed on chain|custom program error|transaction failed/i.test(
    msg
  );
}

/** Converts a raw error message into a short, actionable line. Unknown
 *  messages pass through trimmed (never invent a cause). */
export function friendlyTxError(raw: string): string {
  const msg = raw.trim();
  if (isBlockhashExpiredError(msg)) {
    return (
      "Blockhash expired (the network moved on before the tx landed). " +
      "The client retries with a fresh blockhash automatically; if you keep " +
      "seeing this the RPC is slow, wait a moment and retry."
    );
  }
  if (isRateLimitError(msg)) {
    return (
      "RPC rate limit hit (HTTP 429). The endpoint pool is backing off; " +
      "wait a few seconds and retry."
    );
  }
  if (isRentError(msg)) {
    return (
      "Insufficient balance to stay rent-exempt after this transaction. " +
      "Top up the wallet and retry."
    );
  }
  if (isInsufficientFundsError(msg)) {
    return "Insufficient funds in the paying wallet for this transaction.";
  }
  if (isOnChainRevert(msg)) {
    return "The transaction reverted on chain (see the raw error below).";
  }
  return msg.length > 320 ? `${msg.slice(0, 317)}...` : msg;
}

/** Honest bundle-drop summary for the UI: states that nothing was created,
 *  shows what happened per attempt, and gives the retry path. Never claims
 *  success for a bundle that did not land. */
export function bundleDropMessage(r: {
  outcome: string;
  bundleId?: string;
  landedSlot?: number | null;
  attempts: {
    attempt: number;
    tipLamports?: number;
    bundleId?: string;
    status?: string;
    rejectionReason?: string | null;
    rejectionMsg?: string | null;
    sendError?: string;
  }[];
  note?: string;
}): string {
  const attempts = Array.isArray(r.attempts) ? r.attempts : [];
  const lastTip = attempts.length > 0 ? attempts[attempts.length - 1].tipLamports : undefined;
  const tipLine =
    lastTip !== undefined
      ? ` (last attempt tip ${(lastTip / 1_000_000_000).toFixed(6)} SOL)`
      : "";
  const detail =
    attempts.length > 0
      ? attempts
          .map(
            (a) =>
              `attempt ${a.attempt}${a.status ? ` ${a.status}` : ""}${
                a.rejectionReason ? ` reason: ${a.rejectionReason}` : ""
              }${
                a.rejectionMsg ? ` msg: ${a.rejectionMsg}` : ""
              }${a.sendError ? ` error: ${a.sendError}` : ""}`
          )
          .join("; ")
      : "no attempts recorded";
  const head =
    r.outcome === "pending"
      ? `JITO BUNDLE STATUS UNKNOWN (${r.outcome}${tipLine}): no final status within the poll window.`
      : `JITO BUNDLE DID NOT LAND (${r.outcome}${tipLine}).`;
  const tail =
    r.outcome === "pending" && r.bundleId
      ? ` The bundle may still land: poll bundle id ${r.bundleId} before retrying so a retry cannot create a duplicate token.`
      : " The launch transactions never executed, so no token was created. Retry the launch (a fresh launch uses a fresh nonce and bundle id). On devnet, use Tier 1 normal sends.";
  const note = r.note ? ` ${r.note}` : "";
  return `${head} ${detail}.${tail}${note}`;
}
