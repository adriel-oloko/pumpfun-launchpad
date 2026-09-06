// Tier 2 atomic-launch relay submission (NextBlock PRIMARY + Astralane Iris
// and bloXroute OPTIONAL FALLBACKS), the Solana analog of v4-launchpad's
// flashbots-proxy.
//
// WHY RELAYS: a launch (fund -> create -> buy) must land atomically (all txs
// or none) inside one slot, which only a block-engine bundle guarantees.
// Tier 2 submits the launch as a bundle to Astralane Iris first; bloXroute's
// Trader API is an OPTIONAL fallback fired ONLY when Astralane explicitly
// rejects or is unreachable (sequential fallback, never simultaneous).
//
// PER-PROVIDER TIPS (critical): every relay only recognizes ITS OWN tip
// accounts. Jito pays `96gYZ...`/Jito block-engine accounts, Astralane pays
// `astra...` wallets, bloXroute pays its own `bLx...`/`3UQU...` wallets. A
// bundle tipped to the WRONG relay's account is not recognized as a tip (it
// is just an ordinary transfer, or worse the relay drops the bundle). So the
// browser assembles a PROVIDER-SPECIFIC signed bundle per relay — each with
// that relay's recognized tip account in the LAST tx — and the proxy never
// cross-sends a variant. See KNOWN_ASTRALANE_TIP_ACCOUNTS /
// KNOWN_BLOXROUTE_TIP_ACCOUNTS / lib/bundle/jito.ts KNOWN_TIP_ACCOUNTS.
//
// DIALECTS (researched live 2026-09-06 against the official docs):
//   - NextBlock submit-batch (HTTP POST to
//     https://<region>.nextblock.io/api/v2/submit-batch with an Authorization
//     api key header, server-side secret): body
//     {entries:[{transaction:{content}}]}. Atomic 2-4 tx bundle; NO useBundle
//     flag (the endpoint IS the bundle). Tip = plain SOL transfer to a
//     NextBlock tip wallet (>= 0.001 SOL), in the final tx. Response
//     {signature} on 200; {code,message} on 400. No bundle status API.
//     Docs: docs.nextblock.io.
//   - Astralane Iris sendBundle (JSON-RPC POST to
//     https://edge.astralane.io/iris?api-key=<key>, regional gateways share
//     /iris): params [[base64...], {encoding:"base64", mevProtect:true,
//     revertProtection:false}]. API key server-side (query param and/or
//     api_key header). Result = bundle id OR a list of tx signatures. Up to
//     4 txs. Min free-tier tip 0.001 SOL (1_000_000 lamports). Docs:
//     astralane.gitbook.io/docs/low-latency/{submit-transactions,
//     endpoints-and-configs,send-txn-fee-tiers}.
//   - bloXroute Solana Trader API POST
//     https://ny.solana.dex.blxrbdn.com/api/v2/submit-batch with an
//     Authorization JWT (server-side secret): body
//     {entries:[{transaction:{content},skipPreflight}], useBundle:true,
//     frontRunningProtection:true}. useBundle=true = atomic block-engine
//     bundle capped at 4 txs; tip only in the FINAL tx, paid to an official
//     bloXroute tipping wallet (>= 0.001 SOL). Response
//     {transactions:[{signature,submitted}]}. Docs:
//     docs.bloxroute.com/solana/trader-api/...
//   - Jito (LEGACY, NOT in the active Tier 2 order): open JSON-RPC
//     sendBundle to https://mainnet.block-engine.jito.wtf/api/v1/bundles,
//     params [[base64...], {encoding:"base64"}], no auth. Retained as
//     compatibility (diagnostic scripts, status polling, the old
//     JitoBundleClient.submitWithRetry); Jito is deliberately NOT part of
//     RELAY_ORDER so the active Tier 2 path never builds or sends a
//     Jito-tipped bundle.
//
// SECRETS: the bloXroute JWT and the Astralane API key live ONLY server-side
// (env, never NEXT_PUBLIC_*) and are attached in the proxy route
// (app/api/bundle-relay/route.ts), never in the browser bundle. This module
// is browser-safe: it builds requests and classifies responses, and the
// same-origin /api/bundle-relay route does the authenticated submission.

/** Relay identifiers. jito is a legacy compatibility relay, NOT part of the
 *  active Tier 2 order (see the module header). */
export type RelayId = "jito" | "bloxroute" | "astralane" | "nextblock";

/** Role of each relay in the Tier 2 plan (drives UI/log copy). */
export type RelayRole = "primary" | "fallback" | "legacy";

export const RELAY_ROLE: Record<RelayId, RelayRole> = {
  nextblock: "primary",
  astralane: "fallback",
  bloxroute: "fallback",
  jito: "legacy",
};

/** ACTIVE Tier 2 submission order: NextBlock PRIMARY, Astralane Iris and
 *  bloXroute as OPTIONAL fallbacks. Sequential: the next relay is only tried
 *  when the previous one explicitly rejects or is unreachable. */
export const TIER2_RELAY_ORDER: RelayId[] = ["nextblock", "astralane", "bloxroute"];

/** Backwards-compatible name for the active Tier 2 order. */
export const RELAY_ORDER: RelayId[] = TIER2_RELAY_ORDER;

/** Jito mainnet block engine (open, no auth). jito-js-rpc posts sendBundle
 *  to <endpoint>/bundles; this is that endpoint's base. */
export const JITO_BLOCK_ENGINE_MAINNET =
  "https://mainnet.block-engine.jito.wtf/api/v1";

/** Astralane global edge Iris endpoint; the api key rides as a query param.
 *  Regional gateways (fr/ny/ams/la/jp/sg/...) share the /iris path. */
export const ASTRALANE_EDGE_URL = "https://edge.astralane.io/iris";

/** bloXroute Solana Trader API bundle endpoint (submit-batch, useBundle).
 *  Region mirrors exist (ny/ams/...solana.dex.blxrbdn.com); ny is default. */
export const BLOXROUTE_SOLANA_URL =
  "https://ny.solana.dex.blxrbdn.com/api/v2/submit-batch";

/** NextBlock submit-batch endpoint (the atomic bundle path, 2-4 txs). The
 *  Authorization API key rides as a header; ny is the default region and
 *  other region hosts (frankfurt/amsterdam/london/singapore/tokyo/slc/
 *  dublin/vilnius.nextblock.io) share /api/v2/submit-batch. */
export const NEXTBLOCK_SUBMIT_BATCH_URL =
  "https://ny.nextblock.io/api/v2/submit-batch";

/** Per-relay bundle caps (tx count). The ACTIVE Tier 2 relays (NextBlock,
 *  Astralane, bloXroute) cap bundles at 4 txs; Jito (legacy) allows 5.
 *  NextBlock also enforces a 2-tx MINIMUM on submit-batch (the atomic launch
 *  is always >= 3 txs so this never bites, but a 1-tx batch is invalid there).
 *  A bundle over a relay's cap is skipped for that relay with an honest
 *  rejection, never truncated. A 3-tx launch (fund, create, buy+tip) fits
 *  every active cap. */
export const RELAY_BUNDLE_CAPS: Record<RelayId, number> = {
  nextblock: 4,
  astralane: 4,
  bloxroute: 4,
  jito: 5,
};

/** The tip account list Jito exposes (legacy path only: the active Tier 2
 *  relays each recognize their OWN tip accounts below, never Jito's). */
export const KNOWN_JITO_TIP_ACCOUNTS: string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
];

/** Official Astralane Iris tip wallets (docs "Tipping Address"; rotate to
 *  reduce write-lock contention). The sendBundle code sample in the docs
 *  uses astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm. Source:
 *  astralane.gitbook.io/docs/low-latency/endpoints-and-configs. */
export const KNOWN_ASTRALANE_TIP_ACCOUNTS: string[] = [
  "astra4uejePWneqNaJKuFFA8oonqCE1sqF6b45kDMZm",
  "astrazznxsGUhWShqgNtAdfrzP2G83DzcWVJDxwV9bF",
  "astra9xWY93QyfG6yM8zwsKsRodscjQ2uU2HKNL5prk",
  "astraRVUuTHjpwEVvNBeQEgwYx9w9CFyfxjYoobCZhL",
  "astraEJ2fEj8Xmy6KLG7B3VfbKfsHXhHrNdCQx7iGJK",
  "astraubkDw81n4LuutzSQ8uzHCv4BhPVhfvTcYv8SKC",
  "astraZW5GLFefxNPAatceHhYjfA1ciq9gvfEg2S47xk",
  "astrawVNP4xDBKT7rAdxrLYiTSTdqtUr63fSMduivXK",
];

/** Official bloXroute Trader API tip-receiving addresses (docs recommend
 *  rotating). Every Trader API submission must include a system transfer >=
 *  0.001 SOL to one of these. Source:
 *  docs.bloxroute.com/solana/trader-api/introduction/tip-and-tipping-addresses */
export const KNOWN_BLOXROUTE_TIP_ACCOUNTS: string[] = [
  "3UQUKjhMKaY2S6bjcQD6yHB7utcZt5bfarRCmctpRtUd",
  "FogxVNs6Mm2w9rnGL1vkARSwJxvLE8mujTv3LK8RnUhF",
  "bLx7MvxGaKdKL7mEbpk9tC79z6MnBSJoJkuaEAPu6Nd",
  "bLx7XBqSg3LUPVf1bRgCnkJmgVZR8QEgDJBPqcRLHvp",
  "bLx8KeZxinPwy6kkUgyzMLeqb2ARNsWjADG1dhSsVba",
  "bLxADBknoNj8WAGw2W6GBYeq848Xx6ajhaymV1YvrHm",
  "bLxAc88vRBwvcUQJEgcxNfBLvHPikY4csNsUmPeWea2",
  "bLxQ88oCiTsL8Xj4YWekKi1hjrgmbE3J3FFZ2xZHR3h",
  "bLxS7NoLuynNRJ4mCnEE2YbtwJFttYsEyp2ME7rp2yt",
  "bLxW6mCov7VEbrKc3S9tcBRcfSzRnLCbNp3Dfn3SJG5",
  "bLxXSGXs4mYPTC5okZXed1qzvjNwNJ48QJ82hT2V7w7",
  "bLxYi3vojbbB7hVzVDVTdBLVPhp7GJ3ZB3BwdK5sFXi",
  "bLxhLPgBXtUpX4b1bH3HatuMGMSKT9GnwtuCGiMSAqe",
  "bLxpY1mniuFW4PgkNA4JiNxoeKHFszryi6tNgyZAiAA",
  "bLxuETxd2tgWxBALNwPzAfHhsik4BzD3nrEBCiPNZQD",
  "bLxuL2gK5FW7xfahvwLrxLyW76vcCpNsKQY2CmnE6kV",
  "bLxv4Hnub7nDJWHs8s17o9bGU65Bnx6Yqp2fqtMgHmm",
];

/** Official NextBlock tip wallets (docs Quickstart "Tip Wallets"). A plain
 *  SOL transfer to one of these IS the tip; higher tip = higher priority.
 *  Rotate to reduce write-lock contention. The docs submit-batch sample pays
 *  nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG. */
export const KNOWN_NEXTBLOCK_TIP_ACCOUNTS: string[] = [
  "NextbLoCkVtMGcV47JzewQdvBpLqT9TxQFozQkN98pE",
  "NexTbLoCkWykbLuB1NkjXgFWkX9oAtcoagQegygXXA2",
  "NeXTBLoCKs9F1y5PJS9CKrFNNLU1keHW71rfh7KgA1X",
  "NexTBLockJYZ7QD7p2byrUa6df8ndV2WSd8GkbWqfbb",
  "neXtBLock1LeC67jYd1QdAa32kbVeubsfPNTJC1V5At",
  "nEXTBLockYgngeRmRrjDV31mGSekVPqZoMGhQEZtPVG",
  "NEXTbLoCkB51HpLBLojQfpyVAMorm3zzKg7w9NFdqid",
  "nextBLoCkPMgmG8ZgJtABeScP35qLa2AMCNKntAP7Xc",
];

/** Per-relay minimum bundle tip, lamports. NextBlock (docs: "fee too low;
 *  transaction contains low tip" error + tip floor API), Astralane (free
 *  tier min 0.001 SOL) and bloXroute (docs: min required tip 0.001 SOL) all
 *  floor at 1_000_000 lamports. Jito's block engine floor is 1000 lamports
 *  (legacy path only). */
export const RELAY_MIN_TIP_LAMPORTS: Record<RelayId, number> = {
  nextblock: 1_000_000,
  astralane: 1_000_000,
  bloxroute: 1_000_000,
  jito: 1_000,
};

/** The recognized tip-account list for a relay. jito's block engine rotates
 *  its accounts live (the legacy JitoBundleClient fetches them at runtime);
 *  the list here is the well-known subset. Astralane and bloXroute publish
 *  static official lists, which is what the provider-specific assembly uses. */
export function tipAccountsForRelay(relay: RelayId): string[] {
  switch (relay) {
    case "nextblock":
      return KNOWN_NEXTBLOCK_TIP_ACCOUNTS;
    case "astralane":
      return KNOWN_ASTRALANE_TIP_ACCOUNTS;
    case "bloxroute":
      return KNOWN_BLOXROUTE_TIP_ACCOUNTS;
    case "jito":
      return KNOWN_JITO_TIP_ACCOUNTS;
  }
}

/** Default tip account (base58) used to assemble a relay's provider-specific
 *  bundle. Deterministic (first official account) so assembly and tests are
 *  reproducible; pass a preferred override to rotate. */
export function defaultTipAccountForRelay(relay: RelayId): string {
  const accounts = tipAccountsForRelay(relay);
  if (accounts.length === 0) {
    throw new Error(`no well-known tip account for relay ${relay}`);
  }
  return accounts[0];
}

/**
 * Resolves the ENABLED relays and their endpoint/auth overrides from the
 * server env. The active Tier 2 order is NextBlock (primary, needs
 * NEXTBLOCK_API_KEY) then Astralane (optional fallback, needs
 * ASTRALANE_API_KEY) then bloXroute (optional fallback, needs BLOXROUTE_JWT).
 * All are SERVER secrets: they must live in non-NEXT_PUBLIC env vars
 * (NEXT_PUBLIC_ would inline them into the browser bundle). A relay without
 * credentials reports "disabled" and is never fired. jito is NEVER
 * auto-enabled: it is a legacy compatibility relay, deliberately absent from
 * the active Tier 2 path (its override is still resolved for the legacy
 * status/diagnostic code that speaks to the block engine). Shared by the
 * proxy route (app/api/bundle-relay/route.ts) and node scripts so the two
 * can never drift apart. Guarded for environments without process.env
 * (browsers return all-disabled).
 */
export function resolveRelayEndpointsFromEnv(): {
  enabled: RelayId[];
  overrides: Record<RelayId, RelayEndpointOverride>;
} {
  const overrides = {} as Record<RelayId, RelayEndpointOverride>;
  const enabled: RelayId[] = [];
  const env: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? process.env : {};

  // jito override is always resolvable (default open block engine) for the
  // legacy status/diagnostic code, but jito is NOT appended to `enabled`.
  overrides.jito = {
    id: "jito",
    url: env.RELAY_JITO_URL ?? JITO_BLOCK_ENGINE_MAINNET,
  };

  const nextblockKey = env.NEXTBLOCK_API_KEY?.trim();
  if (nextblockKey) {
    overrides.nextblock = {
      id: "nextblock",
      url: env.NEXTBLOCK_URL ?? NEXTBLOCK_SUBMIT_BATCH_URL,
      // NextBlock authenticates with a single API key in the Authorization
      // (docs use the lowercase `authorization`) header.
      authHeaderValue: nextblockKey,
      authHeaderName: "authorization",
    };
    enabled.push("nextblock");
  }

  const astraKey = env.ASTRALANE_API_KEY?.trim();
  if (astraKey) {
    overrides.astralane = {
      id: "astralane",
      url: env.ASTRALANE_URL ?? ASTRALANE_EDGE_URL,
      // The api key rides as the ?api-key= query param on the edge URL; the
      // builder appends it when the configured URL lacks it (and mirrors it
      // in the api_key header, the form the docs' code samples use).
      authHeaderValue: astraKey,
    };
    enabled.push("astralane");
  }

  const bloxJwt = env.BLOXROUTE_JWT?.trim();
  if (bloxJwt) {
    overrides.bloxroute = {
      id: "bloxroute",
      url: env.BLOXROUTE_URL ?? BLOXROUTE_SOLANA_URL,
      // The portal hands out the exact Authorization header value ("Bearer
      // eyJ..." or the raw JWT depending on the account tier); paste it
      // verbatim. BLOXROUTE_AUTH_HEADER overrides the header name.
      authHeaderValue: bloxJwt,
      authHeaderName: env.BLOXROUTE_AUTH_HEADER ?? "Authorization",
    };
    enabled.push("bloxroute");
  }

  return { enabled, overrides };
}

/** One entry of the Tier 2 relay plan the proxy reports to the browser
 *  (ids + configured flags only — never secrets). */
export interface RelayPlanEntry {
  id: RelayId;
  /** True when this relay's server-side credentials are configured. */
  configured: boolean;
  /** primary (astralane) / fallback (bloxroute) / legacy (jito). */
  role: RelayRole;
}

/** The full Tier 2 relay plan in RELAY_ORDER, derived from the server env.
 *  Shared by the route's GET ?action=plan and node scripts. */
export function relayPlanFromEnv(): RelayPlanEntry[] {
  const { enabled } = resolveRelayEndpointsFromEnv();
  return RELAY_ORDER.map((id) => ({
    id,
    configured: enabled.includes(id),
    role: RELAY_ROLE[id],
  }));
}

/**
 * Jito-Solana RPC endpoint (e.g. Quicknode "Lil Jit", Triton, Helius). The
 * PUBLIC block engine does NOT populate getBundleStatuses' `rejection_reason`
 * (it returns `value: []`) and removed `simulateBundle` (returns -32601); a
 * Jito-Solana RPC serves both. Read from the server env as JITO_RPC_URL
 * (a SERVER secret, never NEXT_PUBLIC_). Empty string when unconfigured.
 * Guarded for browser contexts (no process.env) like the resolver above.
 */
export function resolveJitoRpcUrl(): string {
  const env: Record<string, string | undefined> =
    typeof process !== "undefined" && process.env ? process.env : {};
  return (env.JITO_RPC_URL ?? "").trim();
}

/** Builds the Jito-Solana RPC `simulateBundle` params. The jito-rpc schema
 * requires pre/post account config arrays aligned 1:1 with the transactions,
 * even when no account snapshots are requested. */
export function buildJitoSimulateParams(base64: string[]): unknown[] {
  const accountConfigs = base64.map(() => null);
  return [
    { encodedTransactions: base64 },
    {
      preExecutionAccountsConfigs: accountConfigs,
      postExecutionAccountsConfigs: [...accountConfigs],
      skipSigVerify: true,
      transactionEncoding: "base64",
      replaceRecentBlockhash: true,
    },
  ];
}

/** One prepared relay request: the exact HTTP call a leg will make. Built by
 *  the dialect builders below, executed by the route or the mock harness
 *  (injectable fetch keeps this module testable without a live network). */
export interface RelayLegRequest {
  relay: RelayId;
  url: string;
  /** HTTP headers (auth attached server-side only). */
  headers: Record<string, string>;
  /** Raw JSON body string. */
  body: string;
  /** Human label of the JSON-RPC method / endpoint used. */
  method: string;
}

export type RelayLegStatus =
  | "accepted"
  | "rejected"
  | "unreachable"
  | "disabled"
  | "skipped";

/** One leg's outcome. accepted carries the relay's bundle id / signature. */
export interface RelayLegResult {
  relay: RelayId;
  status: RelayLegStatus;
  /** Bundle id (Jito/Astralane JSON-RPC result) or first signature
   *  (bloXroute submit-batch) when accepted. */
  bundleId?: string;
  /** Short human detail: rejection reason, error, or skip reason. */
  detail?: string;
  /** Round-trip ms (measured at the caller; 0 when never sent). */
  latencyMs?: number;
}

export interface RelayFanoutResult {
  /** The winning leg (first ACCEPT observed), null when nothing accepted. */
  accepted: RelayLegResult | null;
  /** Every leg's outcome, in RELAY_ORDER. */
  legs: RelayLegResult[];
}

export interface RelayEndpointOverride {
  id: RelayId;
  url: string;
  /** Raw auth header value (server-side secret), or undefined for open. */
  authHeaderValue?: string;
  /** Extra header name when the auth rides a non-Authorization header
   *  (Astralane accepts api_key both in the URI and as a header). */
  authHeaderName?: string;
}

/** JSON-RPC sendBundle body. Astralane and Jito share the method name but
 *  NOT the params: Astralane carries the full bundle config
 *  {encoding:"base64", mevProtect:true, revertProtection:false} (docs request
 *  example), Jito carries only {encoding:"base64"}. Both accept base64-encoded
 *  signed txs in array position 0. */
function jsonRpcSendBundle(
  base64: string[],
  opts: { withEncoding?: boolean; withMevConfig?: boolean; id?: number } = {}
): string {
  const params: unknown[] = [base64];
  if (opts.withEncoding) params.push({ encoding: "base64" });
  if (opts.withMevConfig) {
    params.push({
      encoding: "base64",
      mevProtect: true,
      revertProtection: false,
    });
  }
  return JSON.stringify({
    jsonrpc: "2.0",
    id: opts.id ?? 1,
    method: "sendBundle",
    params,
  });
}

/** bloXroute Trader API submit-batch body (translated dialect):
 *  useBundle=true makes it an atomic block-engine bundle (all land or none),
 *  capped at 4 txs; frontRunningProtection=true withholds the bundle from
 *  validators with elevated sandwich/malicious-ordering risk. The tip must
 *  sit in the FINAL tx and pay an OFFICIAL bloXroute tipping wallet (it
 *  already does: the bundle variant for this relay is assembled with a
 *  KNOWN_BLOXROUTE_TIP_ACCOUNTS account). */
function bloxrouteSubmitBatchBody(base64: string[]): string {
  return JSON.stringify({
    entries: base64.map((content) => ({
      transaction: { content },
      skipPreflight: false,
    })),
    useBundle: true,
    frontRunningProtection: true,
  });
}

/** NextBlock submit-batch body (translated dialect): {entries:[{transaction:
 *  {content}}]}. Atomic 2-4 tx bundle; NO useBundle flag (the endpoint IS
 *  the bundle), no per-entry skipPreflight. The tip is a plain SOL transfer
 *  to a KNOWN_NEXTBLOCK_TIP_ACCOUNTS wallet in the final tx (already done by
 *  the provider-specific assembly). frontRunningProtection is only documented
 *  on the single /submit endpoint; left unset here until confirmed for
 *  submit-batch. */
function nextblockSubmitBatchBody(base64: string[]): string {
  return JSON.stringify({
    entries: base64.map((content) => ({
      transaction: { content },
    })),
  });
}

/** Builds the exact HTTP request for one relay from the shared signed
 *  bundle. Auth (JWT / api key) is NOT attached here: the route injects it
 *  from server-side env via the endpoint override. */
export function buildRelayRequest(
  relay: RelayId,
  base64: string[],
  overrides?: Partial<Record<RelayId, RelayEndpointOverride>>
): RelayLegRequest {
  switch (relay) {
    case "jito": {
      const base = overrides?.jito?.url ?? JITO_BLOCK_ENGINE_MAINNET;
      return {
        relay,
        url: `${base.replace(/\/+$/, "")}/bundles`,
        headers: {},
        method: "sendBundle",
        body: jsonRpcSendBundle(base64, { withEncoding: true }),
      };
    }
    case "astralane": {
      const ov = overrides?.astralane;
      const url = ov?.url ?? ASTRALANE_EDGE_URL;
      const key = ov?.authHeaderValue;
      // The api key rides as a query param (?api-key=...) per the docs
      // endpoint list; when a custom endpoint URL already carries it, no
      // duplicate is appended. The api_key HEADER is sent alongside it: the
      // docs' own code samples authenticate with that header too.
      const finalUrl = key && !/api-key=/.test(url)
        ? `${url}${url.includes("?") ? "&" : "?"}api-key=${encodeURIComponent(key)}`
        : url;
      const headers: Record<string, string> = {};
      if (key) headers["api_key"] = key;
      return {
        relay,
        url: finalUrl,
        headers,
        method: "sendBundle",
        // Astralane Iris bundle config: {encoding:"base64", mevProtect:true,
        // revertProtection:false} (docs request example).
        body: jsonRpcSendBundle(base64, { withMevConfig: true }),
      };
    }
    case "bloxroute": {
      const ov = overrides?.bloxroute;
      const url = ov?.url ?? BLOXROUTE_SOLANA_URL;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (ov?.authHeaderValue) {
        headers[ov.authHeaderName ?? "Authorization"] = ov.authHeaderValue;
      }
      return {
        relay,
        url,
        headers,
        method: "submit-batch",
        body: bloxrouteSubmitBatchBody(base64),
      };
    }
    case "nextblock": {
      const ov = overrides?.nextblock;
      const url = ov?.url ?? NEXTBLOCK_SUBMIT_BATCH_URL;
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (ov?.authHeaderValue) {
        // Docs use the lowercase `authorization` header (case-insensitive in
        // HTTP, but mirror it verbatim). The resolver sets authHeaderName to
        // "authorization"; fall back here for direct callers.
        headers[ov.authHeaderName ?? "authorization"] = ov.authHeaderValue;
      }
      return {
        relay,
        url,
        headers,
        method: "submit-batch",
        body: nextblockSubmitBatchBody(base64),
      };
    }
  }
}

/** Parses a JSON body safely (never throws on malformed input). */
function tryJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/**
 * One JSON-RPC POST to a block-engine-style endpoint with transient retries
 * (WSL outbound fetch is flaky). Used by the Jito status polling, the live
 * probe and the mainnet smoke script so every relay HTTP call shares one
 * retry policy. Returns the parsed JSON-RPC response object.
 */
export async function fetchJsonRpc<T = { result?: unknown; error?: { message?: string } }>(
  url: string,
  method: string,
  params: unknown[],
  opts: { attempts?: number; timeoutMs?: number; fetchFn?: typeof fetch } = {}
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const timeoutMs = opts.timeoutMs ?? 15_000;
  const fetchFn = opts.fetchFn ?? ((globalThis as { fetch: typeof fetch }).fetch);
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`${method} timed out after ${timeoutMs}ms`)), timeoutMs)
      );
      const res = await Promise.race([fetchFn(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      }), timer]);
      return (await res.json()) as T;
    } catch (e) {
      lastErr = e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

export interface ClassifiedLeg {
  status: "accepted" | "rejected";
  bundleId?: string;
  detail?: string;
}

/** Classifies one relay's HTTP response into accepted / rejected. Network
 *  level failures (throw) are classified by the caller as unreachable. */
export function classifyRelayResponse(
  relay: RelayId,
  httpStatus: number,
  rawBody: string
): ClassifiedLeg {
  const json = tryJson(rawBody);
  switch (relay) {
    case "jito":
    case "astralane": {
      // JSON-RPC sendBundle: Jito returns a bundle uuid (string); Astralane
      // returns the bundle id OR a list of tx signatures (docs response
      // example: result: ["37Dx...", ...]). Either shape = accepted.
      const obj = json as { result?: unknown; error?: { message?: string; data?: unknown } } | null;
      const result = obj?.result;
      const bundleId =
        typeof result === "string" && result.length > 0
          ? result
          : Array.isArray(result) &&
              result.length > 0 &&
              result.every((r) => typeof r === "string")
            ? (result[0] as string)
            : null;
      if (bundleId) {
        const isList = Array.isArray(result);
        return {
          status: "accepted",
          bundleId,
          ...(isList ? { detail: `${(result as string[]).length} txs accepted` } : {}),
        };
      }
      const msg = obj?.error?.message
        ? `${obj.error.message}${obj.error.data ? ` (${JSON.stringify(obj.error.data)})` : ""}`
        : `http ${httpStatus}: ${rawBody.slice(0, 200)}`;
      return { status: "rejected", detail: msg };
    }
    case "bloxroute": {
      // submit-batch: {transactions:[{signature,submitted}]}. Accepted when
      // every tx reports submitted (the relay accepted the bundle).
      const obj = json as { transactions?: { signature?: string; submitted?: boolean }[] } | null;
      const txs = obj?.transactions;
      if (Array.isArray(txs) && txs.length > 0) {
        if (txs.every((t) => t.submitted === true)) {
          return {
            status: "accepted",
            bundleId: txs[0].signature,
            detail: `${txs.length} txs accepted`,
          };
        }
        const failed = txs.find((t) => t.submitted !== true);
        return { status: "rejected", detail: `relay rejected ${failed?.signature ?? "a tx"}` };
      }
      return {
        status: "rejected",
        detail: `unexpected submit-batch response: ${rawBody.slice(0, 200)}`,
      };
    }
    case "nextblock": {
      // submit-batch 200: {signature:"bundle-signature"}. Accepted when a
      // signature is present. Error 400: {code, message} = rejected.
      const obj = json as { signature?: string; message?: string; code?: number } | null;
      if (obj?.signature) {
        return { status: "accepted", bundleId: obj.signature };
      }
      const msg = obj?.message
        ? `${obj.message}${obj.code != null ? ` (code ${obj.code})` : ""}`
        : `http ${httpStatus}: ${rawBody.slice(0, 200)}`;
      return { status: "rejected", detail: msg };
    }
  }
}

export interface FanOutOptions {
  /** The signed bundle txs (base64). LEGACY: fanOutToRelays is the old
   *  parallel engine and sends this SAME bundle verbatim to every relay —
   *  fine for the single-relay jito smoke diagnostic, WRONG for the active
   *  Tier 2 path (each relay needs its own tip account; see the module
   *  header and submitRelaysSequentially). */
  base64: string[];
  /** Relays to fan out to (default: RELAY_ORDER). */
  relays?: RelayId[];
  /** Endpoint/auth overrides, injected by the route from server env. */
  overrides?: Record<RelayId, RelayEndpointOverride>;
  /** Which relays are configured (have credentials / are open). A relay not
   *  in this set reports disabled and is never fired. */
  enabled?: RelayId[];
  /** fetch implementation (browser global or node 18+ global). */
  fetchFn?: typeof fetch;
  /** Per-leg timeout. */
  timeoutMs?: number;
  /** Fired the moment a leg accepts (first-accept-wins fast path). */
  onAccept?: (leg: RelayLegResult) => void;
}

/**
 * LEGACY parallel fan-out engine (first-accept-wins). Retained for the Jito
 * diagnostic smoke (scripts/mainnet-bundle-smoke.mjs) and the mock suite;
 * the ACTIVE Tier 2 path submits provider-specific variants SEQUENTIALLY via
 * submitRelaysSequentially — never this function, which would cross-send one
 * Jito-tipped bundle to every relay. Fires every enabled relay's prepared
 * request in PARALLEL (Promise.allSettled) and resolves as soon as the FIRST
 * relay accepts. Every leg gets a bounded timeout; a dead or slow relay can
 * never block the others or hang the caller. All leg outcomes are returned so
 * the caller can report the honest per-relay story when nothing landed.
 */
export async function fanOutToRelays(
  opts: FanOutOptions
): Promise<RelayFanoutResult> {
  const {
    base64,
    relays = RELAY_ORDER,
    overrides,
    enabled,
    fetchFn = (typeof globalThis !== "undefined" && (globalThis as { fetch?: typeof fetch }).fetch)
      ? (globalThis as { fetch: typeof fetch }).fetch
      : (() => {
          throw new Error("no fetch implementation available");
        })(),
    timeoutMs = 12_000,
    onAccept,
  } = opts;

  // One work item per relay. Disabled / over-cap legs are resolved values
  // (never fired); every fired leg catches its own failures internally, so no
  // rejection can escape and dangle.
  const work: Promise<RelayLegResult>[] = relays.map((relay) => {
    const cap = RELAY_BUNDLE_CAPS[relay];
    if (base64.length > cap) {
      return Promise.resolve({
        relay,
        status: "skipped" as RelayLegStatus,
        detail: `bundle has ${base64.length} txs, over this relay's ${cap}-tx cap`,
      });
    }
    if (enabled && !enabled.includes(relay)) {
      return Promise.resolve({
        relay,
        status: "disabled" as RelayLegStatus,
        detail: "no credentials configured for this relay",
      });
    }
    const req = buildRelayRequest(relay, base64, overrides);
    const started = Date.now();
    return (async (): Promise<RelayLegResult> => {
      const timer = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`relay ${relay} timed out after ${timeoutMs}ms`)), timeoutMs)
      );
      try {
        const res = await Promise.race([fetchFn(req.url, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...req.headers },
          body: req.body,
          // signal wiring is the caller's job when fetchFn is a custom fetch
        }), timer]);
        const raw = await res.text();
        const classified = classifyRelayResponse(relay, res.status, raw);
        const latencyMs = Date.now() - started;
        const result: RelayLegResult = {
          relay,
          status: classified.status,
          latencyMs,
          ...(classified.bundleId ? { bundleId: classified.bundleId } : {}),
          ...(classified.detail ? { detail: classified.detail } : {}),
        };
        return result;
      } catch (e) {
        return {
          relay,
          status: "unreachable",
          latencyMs: Date.now() - started,
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    })();
  });

  // First-accept-wins with a fast return: resolve as soon as ANY leg accepts
  // OR every leg has settled without an accept. Legs still in flight when an
  // accept fires keep running (bounded by their own timeouts) and are NOT
  // awaited (the caller wants the winner promptly); they can never reject
  // unhandled (each catches itself). When nothing accepts, every leg has
  // settled by definition, so the full per-leg story is returned for the
  // honest "bundle did not land" reporting.
  const settledSlots: (RelayLegResult | undefined)[] = work.map(() => undefined);
  work.forEach((p, i) => {
    void p.then((r) => {
      settledSlots[i] = r;
    });
  });

  let fired = false;
  let resolveAccept: (v: RelayLegResult | null) => void;
  const firstAcceptP = new Promise<RelayLegResult | null>(
    (res) => (resolveAccept = res)
  );
  let settledCount = 0;
  const allSettledP = new Promise<void>((res) => {
    for (const p of work) {
      void p.then(() => {
        settledCount += 1;
        if (settledCount === work.length) res();
      });
    }
  });
  for (const p of work) {
    void p.then((r) => {
      if (r.status === "accepted" && !fired) {
        fired = true;
        if (onAccept) onAccept(r);
        resolveAccept(r);
      }
    });
  }
  void allSettledP.then(() => {
    if (!fired) resolveAccept(null);
  });

  const accepted = await firstAcceptP;
  // One macrotask flush: legs that settled in the SAME tick as the winning
  // accept (instant failures, fast responders) write their slots in a
  // microtask; letting one macrotask pass collects them into the snapshot
  // without waiting on true slow stragglers.
  await new Promise((r) => setTimeout(r, 0));
  if (accepted) {
    return {
      accepted,
      legs: settledSlots.filter((r): r is RelayLegResult => r !== undefined),
    };
  }
  return { accepted: null, legs: settledSlots as RelayLegResult[] };
}

/** True when any leg reports accepted. */
export function fanoutAccepted(r: RelayFanoutResult): boolean {
  return r.accepted !== null;
}

export interface SequentialSubmitOptions {
  /** PROVIDER-SPECIFIC signed bundle variants keyed by relay id. Each
   *  relay's variant is assembled separately with THAT relay's recognized
   *  tip account in its final tx (see the module header); a variant is only
   *  ever sent to its own relay. A relay without an entry is skipped. */
  bundles: Partial<Record<RelayId, string[]>>;
  /** Relays to attempt, in order (default: RELAY_ORDER = NextBlock primary,
   *  Astralane/bloXroute fallbacks). The NEXT relay is only tried when the
   *  current one explicitly rejects or is unreachable — never in parallel. */
  relays?: RelayId[];
  /** Which relays are configured (have server-side credentials). A relay not
   *  in this set reports disabled and is never fired. */
  enabled?: RelayId[];
  /** Endpoint/auth overrides, injected by the route from server env. */
  overrides?: Record<RelayId, RelayEndpointOverride>;
  /** fetch implementation (browser global or node 18+ global). */
  fetchFn?: typeof fetch;
  /** Per-relay timeout. */
  timeoutMs?: number;
  /** Fired the moment a relay accepts. */
  onAccept?: (leg: RelayLegResult) => void;
}

/**
 * The ACTIVE Tier 2 submission engine: tries each relay SEQUENTIALLY in
 * order (NextBlock primary, then Astralane/bloXroute fallback), each with its
 * OWN provider-specific signed bundle, and stops at the first ACCEPT. A relay is
 * only attempted after the previous one explicitly REJECTED or was
 * UNREACHABLE — never simultaneously, so the same launch content cannot be
 * racing two relays at once. Every relay gets a bounded timeout. All leg
 * outcomes are returned so the caller can report the honest per-relay story
 * when nothing was accepted.
 *
 * ACCEPT is NOT landing: Astralane and bloXroute expose no bundle status API,
 * so an accept means "the relay took the bundle"; the caller's own on-chain
 * verification (the mint appearing) is the ground truth, exactly the M7a rule
 * that only a landed bundle is a launch.
 */
export async function submitRelaysSequentially(
  opts: SequentialSubmitOptions
): Promise<RelayFanoutResult> {
  const {
    bundles,
    relays = RELAY_ORDER,
    enabled,
    overrides,
    fetchFn = (typeof globalThis !== "undefined" && (globalThis as { fetch?: typeof fetch }).fetch)
      ? (globalThis as { fetch: typeof fetch }).fetch
      : (() => {
          throw new Error("no fetch implementation available");
        })(),
    timeoutMs = 12_000,
    onAccept,
  } = opts;
  const legs: RelayLegResult[] = [];

  const fire = async (relay: RelayId): Promise<RelayLegResult> => {
    const req = buildRelayRequest(relay, bundles[relay] as string[], overrides);
    const started = Date.now();
    const timer = new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error(`relay ${relay} timed out after ${timeoutMs}ms`)), timeoutMs)
    );
    try {
      const res = await Promise.race([fetchFn(req.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...req.headers },
        body: req.body,
      }), timer]);
      const raw = await res.text();
      const classified = classifyRelayResponse(relay, res.status, raw);
      const result: RelayLegResult = {
        relay,
        status: classified.status,
        latencyMs: Date.now() - started,
        ...(classified.bundleId ? { bundleId: classified.bundleId } : {}),
        ...(classified.detail ? { detail: classified.detail } : {}),
      };
      return result;
    } catch (e) {
      return {
        relay,
        status: "unreachable",
        latencyMs: Date.now() - started,
        detail: e instanceof Error ? e.message : String(e),
      };
    }
  };

  for (const relay of relays) {
    const cap = RELAY_BUNDLE_CAPS[relay];
    const variant = bundles[relay];
    if (!variant || variant.length === 0) {
      legs.push({
        relay,
        status: "skipped",
        detail: "no provider-specific signed bundle for this relay",
      });
      continue;
    }
    if (variant.length > cap) {
      legs.push({
        relay,
        status: "skipped",
        detail: `bundle has ${variant.length} txs, over this relay's ${cap}-tx cap`,
      });
      continue;
    }
    if (enabled && !enabled.includes(relay)) {
      legs.push({
        relay,
        status: "disabled",
        detail: "no credentials configured for this relay",
      });
      continue;
    }
    const result = await fire(relay);
    legs.push(result);
    if (result.status === "accepted") {
      if (onAccept) onAccept(result);
      return { accepted: result, legs };
    }
    // rejected / unreachable: fall through to the next relay in order.
  }
  return { accepted: null, legs };
}

/** Short one-line summary for logs (the launch panel status line). Includes
 *  each leg's detail (the relay's actual rejection error) so a send-time
 *  rejection is diagnosable instead of just "astralane=rejected". */
export function summarizeFanout(r: RelayFanoutResult): string {
  const acc = r.accepted
    ? `${r.accepted.relay} accepted${r.accepted.bundleId ? ` (${r.accepted.bundleId})` : ""}`
    : "no relay accepted";
  const legs = r.legs
    .map(
      (l) =>
        `${l.relay}=${l.status}${l.bundleId ? `:${l.bundleId.slice(0, 8)}` : ""}${
          l.detail ? ` (${l.detail})` : ""
        }`
    )
    .join(" ");
  return `${acc} [${legs}]`;
}

/**
 * Browser-facing plan fetch: GETs the Tier 2 relay plan from the same-origin
 * proxy route (/api/bundle-relay?action=plan), which resolves the configured
 * relays from SERVER env. The browser uses it to know which provider-specific
 * bundle variants to assemble and what to print in the launch log — it never
 * sees credentials.
 */
export async function fetchRelayPlan(opts?: {
  fetchFn?: typeof fetch;
}): Promise<RelayPlanEntry[]> {
  const g = globalThis as { fetch?: typeof fetch };
  const f =
    opts?.fetchFn ??
    (typeof g.fetch === "function" ? g.fetch : (() => {
      throw new Error("no fetch implementation available");
    })());
  const res = await f("/api/bundle-relay?action=plan");
  const json = (await res.json()) as { relays?: RelayPlanEntry[]; error?: string } | null;
  if (!res.ok || !json || !Array.isArray(json.relays)) {
    throw new Error(
      `relay plan http ${res.status}: ${json?.error ?? "malformed plan response"}`
    );
  }
  return json.relays;
}

/**
 * Browser-facing submit: the launch flow POSTs the PROVIDER-SPECIFIC signed
 * bundle variants (each built with its own relay's tip account) to the
 * SAME-ORIGIN proxy route (/api/bundle-relay), which submits them
 * SEQUENTIALLY — NextBlock primary first, Astralane/bloXroute fallback only
 * on an explicit reject / unreachable — with their server-side credentials
 * attached. Zero CORS, zero secret exposure. Returns the route's JSON (the
 * submission result) or throws with the route's error message when nothing
 * was accepted.
 */
export async function submitBundleViaRelayProxy(opts: {
  /** Provider-specific signed bundle variants keyed by relay id. */
  bundles: Partial<Record<RelayId, string[]>>;
  /** Relays to attempt, in order (default: RELAY_ORDER). */
  relays?: RelayId[];
  fetchFn?: typeof fetch;
}): Promise<RelayFanoutResult> {
  const f = opts.fetchFn ?? ((globalThis as { fetch: typeof fetch }).fetch);
  const res = await f("/api/bundle-relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      bundles: opts.bundles,
      relays: opts.relays ?? RELAY_ORDER,
    }),
  });
  const raw = await res.text();
  let json: unknown = null;
  try {
    json = JSON.parse(raw);
  } catch {
    // fall through to the error path below
  }
  if (!res.ok || !json) {
    const msg =
      json && typeof json === "object" && (json as { error?: string }).error
        ? (json as { error: string }).error
        : `bundle relay proxy http ${res.status}: ${raw.slice(0, 300)}`;
    throw new Error(msg);
  }
  return json as RelayFanoutResult;
}
