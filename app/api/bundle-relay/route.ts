// Milestone M7b: Solana bundle relay fan-out proxy (same-origin route).
//
// The Solana analog of v4-launchpad's app/api/flashbots-proxy/route.ts. The
// browser cannot (and should not) hold relay credentials: bloXroute needs a
// JWT and Astralane needs an API key, both server-side secrets. This route
// receives the ALREADY-SIGNED bundle (base64 txs; the browser assembled and
// signed it locally, so no key material ever touches this server) and fans it
// out to Jito (primary, open endpoint) + bloXroute + Astralane in parallel,
// first-accept-wins, exactly like v4's multi-relay fan-out. Jito is open;
// bloXroute and Astralane are enabled only when their credentials exist in
// the server env (never NEXT_PUBLIC_, which would inline them into the
// browser bundle).
//
// Dialect notes (researched live 2026-09-03):
//   - Jito:      JSON-RPC sendBundle to <block-engine>/bundles, no auth.
//                Result = bundle uuid. Status: getInflightBundleStatuses.
//   - Astralane: Jito-compatible JSON-RPC sendBundle to
//                https://edge.astralane.io/iris?api-key=<key> (regional
//                gateways share /iris). Result = bundle id.
//   - bloXroute: Solana Trader API POST /api/v2/submit-batch with
//                Authorization: <JWT> and a translated body (useBundle=true
//                = atomic block-engine bundle; tip in the final tx).
//                Response {transactions:[{signature,submitted}]}.
//
// The route is deliberately a thin wrapper: the fan-out engine itself lives
// in lib/bundle/relays.ts (pure, unit-testable with an injected fetch) so
// the parallel + first-accept-wins logic is provable without live relays.
//
// BEHAVIOR (POST /api/bundle-relay):
//   body  { base64: string[], relays?: RelayId[] }
//   200   { accepted: RelayLegResult | null, legs: RelayLegResult[] } when a
//         relay accepted (accepted non-null) OR all relays rejected/skipped
//         cleanly (accepted null, every leg has a concrete verdict).
//   502   nothing accepted AND at least one leg was unreachable/errored: the
//         caller must report BUNDLE DID NOT LAND with the honest per-leg
//         detail (never a fabricated landing).
//   400   malformed body / no base64.
//
// BEHAVIOR (GET /api/bundle-relay?action=status&bundleId=...):
//   Polls Jito's getInflightBundleStatuses server-side (the block engine is
//   not browser-CORS-friendly) so the client keeps the existing honest
//   landed/pending reporting after an accept.

import { NextResponse } from "next/server";
import {
  fanOutToRelays,
  summarizeFanout,
  resolveRelayEndpointsFromEnv,
  resolveJitoRpcUrl,
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
  const base64 = (body as { base64?: unknown })?.base64;
  if (!Array.isArray(base64) || base64.length === 0) {
    return NextResponse.json(
      { error: "body.base64 must be a non-empty array of base64 txs" },
      { status: 400 }
    );
  }
  if (
    base64.some(
      (b) => typeof b !== "string" || !/^[A-Za-z0-9+/=]+$/.test(b) || b.length === 0
    )
  ) {
    return NextResponse.json(
      { error: "body.base64 entries must be base64 strings" },
      { status: 400 }
    );
  }

  const requested = (body as { relays?: unknown })?.relays;
  const relays: RelayId[] = Array.isArray(requested)
    ? (requested as RelayId[]).filter((r): r is RelayId =>
        (RELAY_ORDER as string[]).includes(r)
      )
    : RELAY_ORDER;
  if (relays.length === 0) {
    return NextResponse.json({ error: "no valid relays requested" }, { status: 400 });
  }

  const { enabled, overrides } = resolveRelayEndpointsFromEnv();
  let result: RelayFanoutResult;
  try {
    result = await fanOutToRelays({
      base64: base64 as string[],
      relays,
      enabled,
      overrides,
      timeoutMs: RELAY_TIMEOUT_MS,
    });
  } catch (e) {
    return NextResponse.json(
      { error: `relay fan-out failed: ${errText(e)}` },
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

/** GET /api/bundle-relay?action=status&bundleId=<id>: polls the accepting
 *  relay's status. Only Jito exposes an in-flight status API today
 *  (getInflightBundleStatuses); bloXroute/Astralane land-or-silently-drop
 *  and the client falls back to on-chain confirmation for those. */
export async function GET(req: Request): Promise<NextResponse> {
  const url = new URL(req.url);
  const action = url.searchParams.get("action");
  const bundleId = url.searchParams.get("bundleId");
  const relay = url.searchParams.get("relay") ?? "jito";
  if (action !== "status") {
    return NextResponse.json(
      { error: "unsupported action (use action=status)" },
      { status: 400 }
    );
  }
  if (!bundleId) {
    return NextResponse.json({ error: "bundleId query param required" }, { status: 400 });
  }
  if (relay !== "jito") {
    return NextResponse.json(
      { error: `relay ${relay} exposes no status API; only jito is pollable` },
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
    // getInflightBundleStatuses gives the coarse lifecycle (Pending/Landed/
    // Failed/Invalid); getBundleStatuses carries the ACTUAL rejection_reason
    // (BlockhashNotFound, TransactionFailure, ExceedsCostModel, ...). Poll
    // BOTH and merge so the client can show WHY a bundle was rejected instead
    // of the opaque "Invalid" it currently reports.
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
