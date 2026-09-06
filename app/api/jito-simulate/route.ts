// Milestone: Jito-Solana RPC bundle simulation endpoint.
//
// The public block engine REMOVED simulateBundle (it returns -32601 Invalid
// method on every call) and does NOT populate getBundleStatuses'
// rejection_reason. A Jito-Solana RPC (Quicknode "Lil Jit", Triton, Helius)
// serves BOTH. This route proxies `simulateBundle` to that endpoint so a
// rejected/Invalid launch bundle can be re-run atomically to surface the
// EXACT revert reason (TransactionFailure / ExceedsCostModel / TipError /
// BlockhashNotFound / ...) instead of the opaque "Invalid".
//
// BEHAVIOR (POST /api/jito-simulate):
//   body  { base64: string[] }   // the signed bundle txs, base64
//   200   { summary, transactionResults, error?: string }  (raw RPC shapes)
//   400   malformed body / no base64, or JITO_RPC_URL not configured
//   502   the RPC call itself failed
//
// summary is "Succeeded" or a {"Failed":{...}} object; transactionResults is
// the per-tx array (each entry has err/logs/unitsConsumed) so the caller can
// pinpoint WHICH tx reverted and why.

import { NextResponse } from "next/server";
import {
  buildJitoSimulateParams,
  resolveJitoRpcUrl,
} from "../../../lib/bundle/relays";

export const runtime = "nodejs";

const MAX_BODY_BYTES = Number(process.env.JITO_SIM_MAX_BODY_BYTES || String(1 << 20));

export async function POST(req: Request): Promise<NextResponse> {
  const jitoRpcUrl = resolveJitoRpcUrl();
  if (!jitoRpcUrl) {
    return NextResponse.json(
      {
        error:
          "JITO_RPC_URL is not configured. Set it to a Jito-Solana RPC endpoint (e.g. Quicknode 'Lil Jit') to enable simulateBundle.",
      },
      { status: 400 }
    );
  }

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

  const endpoint = jitoRpcUrl.replace(/\/+$/, "");
  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "simulateBundle",
        // Helius (and the Jito-Solana RPC / jito-rpc crate) use an
        // `encodedTransactions` object + a config, NOT the old block-engine
        // `[base64Array, {encoding:"base64"}]` shape. replaceRecentBlockhash +
        // skipSigVerify let us re-run an already-signed bundle against current
        // chain state to surface the exact revert (the diagnostic goal).
        params: buildJitoSimulateParams(base64 as string[]),
      }),
    });
  } catch (e) {
    return NextResponse.json(
      { error: `jito-simulate fetch failed: ${e instanceof Error ? e.message : String(e)}` },
      { status: 502 }
    );
  }

  let json: {
    result?: {
      value?: {
        summary?: unknown;
        transaction_results?: unknown;
        inner_instructions?: unknown;
      };
    };
    error?: { message?: string; code?: number };
  };
  try {
    json = (await res.json()) as typeof json;
  } catch {
    return NextResponse.json(
      { error: `jito-simulate non-JSON response (http ${res.status})` },
      { status: 502 }
    );
  }

  if (json.error) {
    return NextResponse.json(
      {
        error: `${json.error.message ?? "simulateBundle error"}${
          json.error.code != null ? ` (code ${json.error.code})` : ""
        }`,
      },
      { status: 502 }
    );
  }

  const value = json.result?.value;
  return NextResponse.json({
    summary: value?.summary ?? null,
    transactionResults: value?.transaction_results ?? null,
    // Raw result passthrough so the caller can inspect the exact shape if the
    // provider nests it differently (parsed fields above are convenience).
    raw: json.result ?? null,
  });
}
