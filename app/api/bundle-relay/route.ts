// Tier 2 atomic-launch relay proxy (same-origin route).
//
// The Solana analog of v4-launchpad's app/api/flashbots-proxy/route.ts. The
// browser cannot (and should not) hold relay credentials: bloXroute needs a
// JWT and Astralane needs an API key, both server-side secrets. This route
// receives the ALREADY-SIGNED provider-specific bundle variants (base64 txs;
// the browser assembled and signed each variant locally with that relay's own
// tip account, so no key material ever touches this server) and submits them
// SEQUENTIALLY — Astralane Iris primary first, bloXroute fallback ONLY when
// Astralane explicitly rejects or is unreachable. Jito is a legacy
// compatibility relay and is never enabled here.
//
// Dialect notes (researched live 2026-09-06 against the official docs):
//   - Astralane: JSON-RPC sendBundle to https://edge.astralane.io/iris
//     ?api-key=<key> (regional gateways share /iris), params [[base64...],
//     {encoding:"base64", mevProtect:true, revertProtection:false}]. API key
//     rides as the query param AND the api_key header. Result = bundle id or
//     a list of tx signatures. Up to 4 txs; min tip 0.001 SOL.
//   - bloXroute: Solana Trader API POST /api/v2/submit-batch with
//     Authorization: *** and a translated body
//     {entries:[{transaction:{content},skipPreflight}], useBundle:true,
//     frontRunningProtection:true} (useBundle=true = atomic block-engine
//     bundle; tip only in the final tx, paid to an official bloXroute wallet).
//     Response {transactions:[{signature,submitted}]}. Up to 4 txs.
//
// The route is deliberately a thin wrapper: the sequential submission engine
// lives in lib/bundle/relays.ts (pure, unit-testable with an injected fetch)
// so the ordering + fallback logic is provable without live relays.
//
// BEHAVIOR (POST /api/bundle-relay):
//   body  { bundles: { [relay]: string[] }, relays?: RelayId[] }
//         bundles = PROVIDER-SPECIFIC signed txs per relay (each relay only
//         ever receives ITS OWN variant). relays = attempt order (default
//         RELAY_ORDER: astralane then bloxroute).
//   200   { accepted: RelayLegResult | null, legs: RelayLegResult[] } when a
//         relay accepted (accepted non-null) OR all relays rejected/skipped/
//         disabled cleanly (accepted null, every leg has a concrete verdict).
//   502   nothing accepted AND at least one leg was unreachable/errored: the
//         caller must report BUNDLE DID NOT LAND with the honest per-leg
//         detail (never a fabricated landing).
//   400   malformed body / no bundles.
//
// BEHAVIOR (GET /api/bundle-relay):
//   ?action=plan    -> { relays: RelayPlanEntry[] } — which relays are
//         configured server-side (ids + configured flags ONLY, no secrets).
//         The browser uses it to assemble exactly the enabled relays'
//         variants and to print honest "astralane primary / bloxroute
//         fallback" status.
//   ?action=status&relay=jito&bundleId=...  -> legacy Jito status polling
//         (the active Tier 2 relays expose no bundle status API; this stays
//         for the legacy diagnostic path).
//
// An ACCEPT is not proof of landing: Astralane and bloXroute expose no bundle
// status API, so the client resolves landing with its own on-chain
// verification (the mint appearing). This route never fabricates a status.

import { NextResponse } from "next/server";
import {
  submitRelaysSequentially,
  summarizeFanout,
  resolveRelayEndpointsFromEnv,
  resolveJitoRpcUrl,
  relayPlanFromEnv,
  type RelayFanoutResult,
  type RelayId,
  RELAY_ORDER,
} from "../../../lib/bundle/relays";

export const runtime = "nodejs";

const RELAY_TIMEOUT_MS = Number(process.env.RELAY_TIMEOUT_MS || "12000");
const MAX_BODY_BYTES = Number(process.env.RELAY_MAX_BODY_BYTES || String(1 << 20));

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

const BASE64_RE = /^[A-Za-z0-9+/=]+$/;

/** True when the value is a non-empty array of base64 tx strings. */
function isBase64Array(v: unknown): v is string[] {
  return (
    Array.isArray(v) &&
    v.length > 0 &&
    v.every((b) => typeof b === "string" && BASE64_RE.test(b) && b.length > 0)
  );
}

export async function POST(req: Request): Promise<NextResponse> {
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) {
    return NextResponse.json(
      { error: `body over the ${MAX_BODY_BYTES}-byte cap` },
      { status: 413 }
    );
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: "invalid JSON body" }, { status: 400 });
  }
  const bundlesRaw = (body as { bundles?: unknown })?.bundles;
  if (
    typeof bundlesRaw !== "object" ||
    bundlesRaw === null ||
    Array.isArray(bundlesRaw)
  ) {
    return NextResponse.json(
      {
        error:
          "body.bundles must be an object of PROVIDER-SPECIFIC signed txs, e.g. {astralane: [...], bloxroute: [...]}",
      },
      { status: 400 }
    );
  }
  const bundles = bundlesRaw as Record<string, unknown>;
  const bundleRelays = Object.keys(bundles) as RelayId[];
  if (bundleRelays.length === 0) {
    return NextResponse.json(
      { error: "body.bundles must carry at least one relay variant" },
      { status: 400 }
    );
  }
  for (const relay of bundleRelays) {
    if (!(RELAY_ORDER as string[]).includes(relay) && relay !== "jito") {
      return NextResponse.json(
        { error: `unknown relay "${relay}" in body.bundles` },
        { status: 400 }
      );
    }
    if (!isBase64Array(bundles[relay])) {
      return NextResponse.json(
        { error: `body.bundles.${relay} must be a non-empty array of base64 txs` },
        { status: 400 }
      );
    }
  }

  const requested = (body as { relays?: unknown })?.relays;
  const relays: RelayId[] = Array.isArray(requested)
    ? (requested as RelayId[]).filter((r): r is RelayId =>
        ((RELAY_ORDER as string[]).concat("jito")).includes(r)
      )
    : RELAY_ORDER;
  if (relays.length === 0) {
    return NextResponse.json({ error: "no valid relays requested" }, { status: 400 });
  }

  const { enabled, overrides } = resolveRelayEndpointsFromEnv();
  let result: RelayFanoutResult;
  try {
    result = await submitRelaysSequentially({
      bundles: bundles as Partial<Record<RelayId, string[]>>,
      relays,
      enabled,
      overrides,
      timeoutMs: RELAY_TIMEOUT_MS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `relay submission failed: ${errText(e)}` },
      { status: 502 }
    );
  }

  const accepted = result.accepted;
  if (accepted) {
    return NextResponse.json(result, { status: 200 });
  }

  // Nothing accepted. When every leg has a concrete verdict (rejected /
  // skipped / disabled) the request is done but the bundle did NOT land:
  // return 200 with accepted=null so the caller can show the honest message
  // with the per-leg detail. When a leg was unreachable the relay stack may
  // be down: surface 502 so the caller treats it as a submission failure.
  const anyUnreachable = result.legs.some(
    (l) => l.status === "unreachable" || l.status === "skipped"
  );
  const status = anyUnreachable ? 502 : 200;
  return NextResponse.json(
    {
      ...result,
      error: `bundle not accepted by any relay: ${summarizeFanout(result)}`,
    },
    { status }
  );
}

/** GET /api/bundle-relay: ?action=plan (configured relays, no secrets) or
 *  the legacy ?action=status&relay=jito poll. The ACTIVE Tier 2 relays
 *  (Astralane/bloXroute) expose no in-flight status API today; the client
 *  falls back to on-chain confirmation for those. */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  if (action === "plan") {
    // ids + configured flags only — never credentials.
    return NextResponse.json({ relays: relayPlanFromEnv() });
  }
  const bundleId = url.searchParams.get("bundleId");
  const relay = url.searchParams.get("relay") ?? "jito";
  if (action !== "status") {
    return NextResponse.json(
      { error: "unsupported action (use action=plan or action=status)" },
      { status: 400 }
    );
  }
  if (!bundleId) {
    return NextResponse.json({ error: "bundleId query param required" }, { status: 400 });
  }
  if (relay !== "jito") {
    return NextResponse.json(
      { error: `relay ${relay} exposes no status API; only jito is pollable (legacy)` },
      { status: 400 }
    );
  }
  const { overrides } = resolveRelayEndpointsFromEnv();
  const base = overrides.jito.url.replace(/\/+$/, "");
  // getInflightBundleStatuses (coarse lifecycle: Pending/Landed/Failed/
  // Invalid) is a BLOCK ENGINE method only. getBundleStatuses' rejection_reason
  // is only populated by a Jito-Solana RPC (Quicknode "Lil Jit" / Triton /
  // Helius), NOT the public block engine (which returns value: [] for it). So
  // poll the coarse status from the block engine and the detailed status from
  // the Jito RPC when one is configured; otherwise fall back to the block
  // engine for both (rejection_reason then comes back null, the old behavior).
  const jitoRpcUrl = resolveJitoRpcUrl();
  const blockEngineBundles = `${base}/bundles`;
  const rpcRoot = jitoRpcUrl ? jitoRpcUrl.replace(/\/+$/, "") : blockEngineBundles;
  const post = async (endpoint: string, method: string, params: unknown[]) => {
    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    });
    return (await res.json()) as {
      result?: { value?: Record<string, unknown>[] };
      error?: { message?: string };
    };
  };
  try {
    const [inflight, detailed] = await Promise.all([
      post(blockEngineBundles, "getInflightBundleStatuses", [[bundleId]]),
      post(rpcRoot, "getBundleStatuses", [[bundleId]]),
    ]);
    const inflightErr = inflight.error?.message;
    const detailedErr = detailed.error?.message;
    if (inflightErr && detailedErr) {
      return NextResponse.json({ error: inflightErr ?? detailedErr }, { status: 502 });
    }
    const iv = inflight.result?.value?.[0] as
      | { status?: string; landed_slot?: number | null }
      | undefined;
    const dv = detailed.result?.value?.[0] as
      | {
          bundle_id?: string;
          slot?: number;
          confirmation_status?: string;
          rejection_reason?: { reason?: string; msg?: string } | null;
          err?: unknown;
        }
      | undefined;
    const status = iv?.status ?? null;
    const landedSlot = iv?.landed_slot ?? null;
    const rejection = dv?.rejection_reason ?? null;
    return NextResponse.json({
      status,
      landedSlot,
      rejectionReason: rejection?.reason ?? null,
      rejectionMsg: rejection?.msg ?? null,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `jito status unreachable: ${errText(e)}` },
      { status: 502 }
    );
  }
}
