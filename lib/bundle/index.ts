// Multi-wallet atomic launch (relay bundle) module.
//
// Public surface:
//   launch.ts   - buildLaunchSequence, packBuyTxs, preflightLaunch,
//                 sendSequentially, walletTokenBalance,
//                 holderCount, ataRentLamports, MAX_TX_BYTES, MAX_COMPUTE_UNITS
//   jito.ts     - RELAY-AGNOSTIC bundle assembly (JitoBundleClient.
//                 assembleBundle, used once per relay with that relay's own
//                 tip account), simulateBundle, plus the LEGACY Jito
//                 submission path (submitWithRetry) kept as compatibility.
//   relays.ts   - Tier 2 relay submission: NextBlock PRIMARY + Astralane
//                 Iris / bloXroute OPTIONAL FALLBACKS
//                 (submitRelaysSequentially),
//                 official per-relay tip accounts + 0.001 SOL tip floors,
//                 exact request dialects, response classification, the
//                 server-env resolver/plan, and the legacy parallel
//                 fanOutToRelays (diagnostics only).
//   fanout-submit.ts - Tier 2 submitter (no tip escalation) that assembles a
//                 PROVIDER-SPECIFIC signed bundle per relay and submits them
//                 sequentially through the same-origin proxy
//                 (submitBundleViaFanoutWithRetry); drop-in for
//                 submitWithRetry with the same BundleSubmissionResult.
//   lookup.ts   - address-lookup-table helpers for the preflight sandbox.
//
// Tier 2 order (RELAY_ORDER): nextblock -> astralane -> bloxroute. Jito is
// NOT in the active order; it is kept as legacy compatibility (diagnostic
// scripts, the jito status poll, submitWithRetry).

export * from "./launch";
export * from "./jito";
export * from "./lookup";
export * from "./relays";
export * from "./fanout-submit";
