// Milestone M9: metadata VPS receiver + static file server (dependency-free).
//
// The "preferred" metadata backend for pumpfun-launchpad mainnet tokens: a
// dumb file store on your own box. The Next.js publish route
// (app/api/metadata/publish/route.ts) PUTs the raw image bytes and the raw
// metadata.json bytes here with a shared secret; this server writes them
// under METADATA_ROOT and serves them back over plain GET. No metadata
// logic lives here — the launchpad composes the JSON, this box just stores
// and serves it.
//
// WHY VPS (mainnet answer): the operator owns the box (no recurring pinning
// bill), image + JSON live together under one stable URL, and the
// launchpad already self-hosts services on a VPS. The single-host risk is
// real (the on-chain uri is immutable), so ALSO archive each token's JSON +
// image to IPFS/Arweave at launch as insurance.
//
// RUNBOOK (as the service user, from this repo or anywhere on the box):
//
//   node tools/metadata-vps/server.mjs
//
//   env:
//     METADATA_SECRET   required, shared with the launchpad server env
//     METADATA_PORT     default 8085
//     METADATA_ROOT     default ./data   (served + written here)
//     METADATA_MAX_BYTES  per-PUT body cap, default 8388608 (8 MiB)
//
//   systemd unit (/etc/systemd/system/pumpfun-metadata.service):
//     [Unit]
//     Description=pumpfun-launchpad metadata store
//     After=network.target
//     [Service]
//     User=metadata
//     WorkingDirectory=/opt/pumpfun-metadata
//     Environment=METADATA_SECRET=<long-random-string>
//     Environment=METADATA_PORT=8085
//     ExecStart=/usr/bin/node /opt/pumpfun-metadata/server.mjs
//     Restart=always
//     [Install]
//     WantedBy=multi-user.target
//
//   Caddy reverse proxy (TLS + the public origin the launchpad's
//   METADATA_VPS_BASE_URL points at):
//     metadata.example.com {
//       reverse_proxy 127.0.0.1:8085
//     }
//   then launchpad server env:
//     METADATA_BACKEND=vps
//     METADATA_VPS_UPLOAD_URL=https://metadata.example.com/put
//     METADATA_VPS_BASE_URL=https://metadata.example.com
//     METADATA_VPS_SECRET=<same-long-random-string>
//
//   Verify:
//     curl -s https://metadata.example.com/health
//     curl -s -X PUT 'https://metadata.example.com/put?path=probe.json' \
//          -H 'x-metadata-secret: <secret>' -H 'content-type: application/json' \
//          -d '{"ok":true}'
//     curl -s https://metadata.example.com/probe.json
//
// ENDPOINTS
//   GET  /health           {ok:true}
//   PUT  /put?path=<rel>   raw body bytes written to METADATA_ROOT/<rel>;
//                          requires header x-metadata-secret === METADATA_SECRET
//   GET  /<rel>            serves METADATA_ROOT/<rel> with a mime type
//
//   path must match [A-Za-z0-9._/-]+ and contain no ".." segments (the
//   launchpad sends "<id>/image.png" and "<id>/metadata.json").
//
// Node >= 18 (global fetch not needed here; plain http module).

import http from "node:http";
import { createReadStream, promises as fsp } from "node:fs";
import path from "node:path";

const SECRET = process.env.METADATA_SECRET ?? "";
const PORT = Number(process.env.METADATA_PORT || 8085);
const ROOT = path.resolve(process.env.METADATA_ROOT || "./data");
const MAX_BYTES = Number(process.env.METADATA_MAX_BYTES || 8 * 1024 * 1024);

if (!SECRET) {
  console.error("METADATA_SECRET is required (shared with the launchpad server env)");
  process.exit(1);
}

const MIME = {
  ".json": "application/json",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

function json(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(data),
    "cache-control": "no-store",
  });
  res.end(data);
}

/** Path inside ROOT, or null when unsafe. */
function safeRel(raw) {
  let rel;
  try {
    rel = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (!rel || rel.startsWith("/") || rel.includes("\0")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((p) => p === ".." || p === ".")) return null;
  return rel;
}

async function serveFile(res, rel) {
  const abs = path.join(ROOT, rel);
  try {
    const s = await fsp.stat(abs);
    if (!s.isFile()) throw new Error("not a file");
    res.writeHead(200, {
      "content-type": MIME[path.extname(rel).toLowerCase()] ?? "application/octet-stream",
      "content-length": s.size,
      "cache-control": "public, max-age=31536000, immutable",
    });
    createReadStream(abs).pipe(res);
  } catch {
    json(res, 404, { error: "not found" });
  }
}

async function handlePut(req, res, rel) {
  const given = req.headers["x-metadata-secret"] ?? "";
  if (!SECRET || given !== SECRET) {
    json(res, 401, { error: "bad or missing x-metadata-secret" });
    req.resume();
    return;
  }
  const abs = path.join(ROOT, rel);
  const dir = path.dirname(abs);
  try {
    await fsp.mkdir(dir, { recursive: true });
  } catch (e) {
    json(res, 500, { error: `mkdir failed: ${e.message}` });
    req.resume();
    return;
  }
  const chunks = [];
  let size = 0;
  let over = false;
  req.on("data", (c) => {
    size += c.length;
    if (size > MAX_BYTES) {
      over = true;
      req.destroy();
      return;
    }
    chunks.push(c);
  });
  req.on("end", async () => {
    if (over) {
      json(res, 413, { error: `body over the ${MAX_BYTES}-byte cap` });
      return;
    }
    try {
      await fsp.writeFile(abs, Buffer.concat(chunks));
      json(res, 200, { ok: true, path: rel, bytes: size });
    } catch (e) {
      json(res, 500, { error: `write failed: ${e.message}` });
    }
  });
  req.on("error", () => {
    if (!res.headersSent) json(res, 400, { error: "request aborted" });
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.pathname.replace(/\/+$/, "") || "/";

  if (req.method === "GET" && p === "/health") {
    json(res, 200, { ok: true });
    return;
  }
  if ((req.method === "PUT" || req.method === "POST") && p === "/put") {
    const rel = safeRel(url.searchParams.get("path") ?? "");
    if (!rel) {
      json(res, 400, { error: "path must be a safe relative path like <id>/image.png" });
      req.resume();
      return;
    }
    handlePut(req, res, rel);
    return;
  }
  if (req.method === "GET") {
    const rel = safeRel(p.slice(1));
    if (!rel) {
      json(res, 400, { error: "unsafe path" });
      return;
    }
    serveFile(res, rel);
    return;
  }
  json(res, 405, { error: "method not allowed" });
});

server.listen(PORT, () => {
  console.log(`[metadata-vps] listening on :${PORT}, root=${ROOT}`);
});

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 2000).unref();
  });
}
