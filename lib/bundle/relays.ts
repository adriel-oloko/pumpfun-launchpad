// Milestone M7b: Solana bundle relay fan-out (Jito primary + bloXroute +
// Astralane), the Solana analog of v4-launchpad's flashbots-proxy.
//
// WHY IT EXISTS: a bundle sent to ONE relay only lands when that relay's
// reachable set wins a slot. Sending the SAME signed bundle to SEVERAL
// relays in parallel (Jito, bloXroute BDN, Astralane) means whichever relay
// reaches the winning leader accepts it, and the others drop it as already
// landed. First relay to ACCEPT wins; the bundle id / signatures of the
// others are harmless (a landed bundle cannot land twice). Jito is the
// primary relay (roughly 90-95% of mainnet validators run Jito-Solana);
// bloXroute and Astralane are redundancy legs like v4's Titan/rsync.
//
// DIALECTS (researched live 2026-09-03, see the route doc comments):
//   - Jito:      JSON-RPC sendBundle to https://mainnet.block-engine.jito.wtf/
//                api/v1/bundles, params [[base64...], {encoding:"base64"}],
//                NO auth (open endpoint). Result = bundle uuid. Up to 5 txs.
//   - Astralane: Jito-compatible JSON-RPC sendBundle to
//                https://edge.astralane.io/iris?api-key=<key> (regional
//                gateways also exist), params [[base64...]]. API key in the
//                URI or an api_key header. Result = bundle id. Up to 4 txs.
//   - bloXroute: Solana Trader API HTTP POST submit-batch to
//                https://ny.solana.dex.blxrbdn.com/api/v2/submit-batch with
//                an Authorization JWT (server-side secret) and a translated
//                body: {entries:[{transaction:{content},skipPreflight}],
//                useBundle:true} (useBundle=true = atomic block-engine
//                bundle; tip only in the final tx, the Jito convention).
//                Response {transactions:[{signature,submitted}]}. Up to 4 txs.
//
// SECRETS: the bloXroute JWT and the Astralane API key live ONLY server-side
// (env, never NEXT_PUBLIC_*) and are attached in the proxy route
// (app/api/bundle-relay/route.ts), never in the browser bundle. This module
// is browser-safe: it builds requests and classifies responses, and the
// same-origin /api/bundle-relay route does the authenticated fan-out.
//
// BUNDLE TIP: the launch flow already appends the Jito tip transfer (a plain
// SOL transfer to a Jito tip account in the LAST bundle tx, lib/bundle/jito.ts
// assembleBundle). That transfer is valid on every relay: it is an ordinary
// transfer, and bloXroute + Astralane use the same "tip in the last tx"
// convention, so ONE signed bundle works on all three relays unchanged.

/** The three relays the fan-out targets. jito is primary. */
export type RelayId = "jito" | "bloxroute" | "astralane";

export const RELAY_ORDER: RelayId[] = ["jito", "bloxroute", "astralane"];

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

/** Per-relay bundle caps (tx count). Jito 5, Astralane + bloXroute 4. A
 *  bundle over a relay's cap is skipped for that relay with an honest
 *  rejection, never truncated. */
export const RELAY_BUNDLE_CAPS: Record<RelayId, number> = {
  jito: 5,
  bloxroute: 4,
  astralane: 4,
};

/** The tip account list Jito exposes; the launch flow pays one of these.
 *  bloXroute and Astralane accept the same transfer as the bundle tip. */
export const KNOWN_JITO_TIP_ACCOUNTS: string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
];

/**
 * Resolves the ENABLED relays and their endpoint/auth overrides from the
 * server env. Jito is always enabled (open endpoint). bloXroute needs
 * BLOXROUTE_JWT; Astralane needs ASTRALANE_API_KEY. Both are SERVER secrets:
 * they must live in non-NEXT_PUBLIC env vars (NEXT_PUBLIC_ would inline them
 * into the browser bundle). A relay without credentials reports "disabled"
 * and is never fired, so the fan-out works with Jito alone. Shared by the
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

  overrides.jito = {
    id: "jito",
    url: env.RELAY_JITO_URL ?? JITO_BLOCK_ENGINE_MAINNET,
  };
  enabled.push("jito");

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

  const astraKey = env.ASTRALANE_API_KEY?.trim();
  if (astraKey) {
    overrides.astralane = {
      id: "astralane",
      url: env.ASTRALANE_URL ?? ASTRALANE_EDGE_URL,
      // The api key rides as the ?api-key= query param on the edge URL; the
      // builder appends it when the configured URL lacks it.
      authHeaderValue: astraKey,
    };
    enabled.push("astralane");
  }

  return { enabled, overrides };
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

/** JSON-RPC sendBundle body, the Jito + Astralane dialect. Astralane omits
 *  the second params entry; Jito carries {encoding:"base64"}. Both accept
 *  base64-encoded signed txs in array position 0. */
function jsonRpcSendBundle(
  base64: string[],
  opts: { withEncoding?: boolean; id?: number } = {}
): string {
  const params: unknown[] = [base64];
  if (opts.withEncoding) params.push({ encoding: "base64" });
  return JSON.stringify({
    jsonrpc: "2.0",
    id: opts.id ?? 1,
    method: "sendBundle",
    params,
  });
}

/** bloXroute Trader API submit-batch body (translated dialect):
 *  useBundle=true makes it an atomic block-engine bundle (all land or none);
 *  the tip must sit in the final tx (it already does, from assembleBundle). */
function bloxrouteSubmitBatchBody(base64: string[]): string {
  return JSON.stringify({
    entries: base64.map((content) => ({
      transaction: { content },
      skipPreflight: false,
    })),
    useBundle: true,
    frontRunningProtection: false,
  });
}

/** Builds the exact HTTP request for one relay from the shared signed
 *  bundle. Auth (JWT / api key) is NOT attached here: the route injects it
 *  from server-side env via the endpoint override. */
export function buildRelayRequest(
  relay: RelayId,
  base64: string[],
  overrides?: Record<RelayId, RelayEndpointOverride>
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
      // The api key rides as a query param (?api-key=...) per the docs; the
      // header form (api_key) is used when a custom endpoint URL omits it.
      const finalUrl = key && !/api-key=/.test(url)
        ? `${url}${url.includes("?") ? "&" : "?"}api-key=${encodeURIComponent(key)}`
        : url;
      const headers: Record<string, string> = {};
      if (key && /api-key=/.test(url)) headers["api_key"] = key;
      return {
        relay,
        url: finalUrl,
        headers,
        method: "sendBundle",
        body: jsonRpcSendBundle(base64, { withEncoding: false }),
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
      // JSON-RPC: result = bundle id (accepted); error = rejected.
      const obj = json as { result?: unknown; error?: { message?: string; data?: unknown } } | null;
      if (obj && typeof obj.result === "string" && obj.result.length > 0) {
        return { status: "accepted", bundleId: obj.result };
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
  }
}

export interface FanOutOptions {
  /** The signed bundle txs (base64). Shared verbatim across every relay. */
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
 * The fan-out engine: fires every enabled relay's prepared request in
 * PARALLEL (Promise.allSettled), and resolves as soon as the FIRST relay
 * accepts (first-accept-wins). Every leg gets a bounded timeout; a dead or
 * slow relay can never block the others or hang the caller. All leg outcomes
 * are returned so the caller can report the honest per-relay story when
 * nothing landed (the M7a "bundle did not land" reporting survives).
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

/** Short one-line summary for logs (the launch panel status line). Includes
 *  each leg's detail (the relay's actual rejection error) so a send-time
 *  rejection is diagnosable instead of just "jito=rejected". */
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
 * Browser-facing submit: the launch flow POSTs the assembled bundle to the
 * SAME-ORIGIN proxy route (/api/bundle-relay), which fans it out to the
 * relays with their server-side credentials attached. Zero CORS, zero secret
 * exposure. Returns the route's JSON (the fan-out result) or throws with the
 * route's error message when nothing accepted.
 */
export async function submitBundleViaRelayProxy(opts: {
  base64: string[];
  relays?: RelayId[];
  fetchFn?: typeof fetch;
}): Promise<RelayFanoutResult> {
  const f = opts.fetchFn ?? ((globalThis as { fetch: typeof fetch }).fetch);
  const res = await f("/api/bundle-relay", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      base64: opts.base64,
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
