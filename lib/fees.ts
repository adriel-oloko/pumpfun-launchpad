// Milestone M7a: fee policy knobs (priority fee + Jito tip).
//
// Single place for the compute-unit price and the Jito bundle tip so every
// tx path (launch, auto buy/sell, sell-all, migration) reads the same
// numbers and an operator can tune them without code edits.
//
// UNITS
//   - Priority fee: micro-lamports per compute unit (setComputeUnitPrice).
//     1_000_000 = 1 lamport per CU. A typical buy burns ~33-200k CU, so the
//     1-lamport floor costs ~0.000033-0.0002 SOL per tx; a 10-lamport/CU
//     mainnet price costs ~0.0003-0.002 SOL per tx.
//   - Jito tip: absolute lamports placed in the LAST bundle tx (min 1000).
//     1_000_000 lamports = 0.001 SOL per bundle.
//
// DEFAULTS vs MAINNET
//   - DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS is a non-zero floor (1 lamport/CU):
//     landable on devnet rehearsal budgets and a sane base on mainnet, where
//     memecoin competition usually needs 5x-20x (see
//     RECOMMENDED_MAINNET_PRIORITY_FEE_MICRO_LAMPORTS).
//   - DEFAULT_JITO_TIP_LAMPORTS is 0.001 SOL, a below-median mainnet tip;
//     bump toward RECOMMENDED_MAINNET_JITO_TIP_LAMPORTS (0.005 SOL) under
//     real competition. Bundles are submitted once at the configured tip (no
//     escalation), so this value is what actually gets paid.
//
// OVERRIDES (env, inlined at build time like every NEXT_PUBLIC var):
//   NEXT_PUBLIC_PRIORITY_FEE_MICRO_LAMPORTS
//   NEXT_PUBLIC_JITO_TIP_LAMPORTS
// See .env.local.example for the documented lines.

function envInt(v: string | undefined, fallback: number): number {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** Default priority fee in micro-lamports per CU (1_000_000 = 1 lamport/CU).
 *  Applied to every launch tx (fund, create, each packed buy) and available
 *  to every other tx builder that takes a priorityFeeMicroLamports knob. */
export const DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS: number = envInt(
  process.env.NEXT_PUBLIC_PRIORITY_FEE_MICRO_LAMPORTS,
  1_000_000
);

/** Recommended mainnet priority fee for race conditions: 10 lamports/CU
 *  (~0.002 SOL on a 200k-CU buy at current congestion). Scale 2-5x higher
 *  when launches are being sniped. */
export const RECOMMENDED_MAINNET_PRIORITY_FEE_MICRO_LAMPORTS: number =
  10_000_000;

/** Default Jito bundle tip in lamports (1_000_000 = 0.001 SOL). Used by
 *  submitWithRetry when the caller does not pass an explicit initial tip. */
export const DEFAULT_JITO_TIP_LAMPORTS: number = envInt(
  process.env.NEXT_PUBLIC_JITO_TIP_LAMPORTS,
  1_000_000
);

/** Recommended mainnet Jito tip: 0.005 SOL per bundle. Bundles are submitted
 *  once at the configured tip (no escalation inside the submission layer). */
export const RECOMMENDED_MAINNET_JITO_TIP_LAMPORTS: number = 5_000_000;

/** Human line for logs: what fees the current build will pay. */
export function feePolicySummary(): string {
  return (
    `priority fee ${DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS} micro-lamports/CU, ` +
    `jito tip ${DEFAULT_JITO_TIP_LAMPORTS} lamports ` +
    `(mainnet recommendation: ${RECOMMENDED_MAINNET_PRIORITY_FEE_MICRO_LAMPORTS} / ${RECOMMENDED_MAINNET_JITO_TIP_LAMPORTS})`
  );
}
