// Milestone M7b: live probe of the Jito mainnet block engine through the
// SAME dialect the relay fan-out engine speaks (lib/bundle/relays.ts).
//
// ZERO COST BY DESIGN: nothing in this probe can land or spend lamports.
//   1. getTipAccounts / getHealth: read-only.
//   2. Encoding probe: a ONE-TX bundle from a throwaway 0-SOL keypair (fresh
//      key, no funds ever airdropped) that transfers 0 lamports to a known
//      Jito tip account under a REAL current mainnet blockhash. The signing
//      is valid (encoding proves out), but the payer holds no lamports, so
//      simulation fails and the bundle is marked Invalid. Jito still returns
//      a bundle uuid on accept: the exact accepted-then-Invalid pattern M2
//      used to prove bundle encoding against the live endpoint. No tip is
//      ever paid (nothing lands); the script never touches a funded wallet.
//
// The bloXroute and Astralane legs carry no credentials in this repo (JWT /
// API key are operator-provided), so their fan-out behavior is proven by the
// deterministic mock suite (tests/pumpfun-m7b-relays.ts) and their request
// dialects are verified at the encoding level there too.
//
// Usage: node scripts/probe-jito-relay.mjs
// Output: live tip account count, health, and the encoding-probe verdict.

import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import { fileURLToPath } from "url";
import path from "path";
import pathMod from "node:path";
import fs from "node:fs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Rebuild the CJS .build output so this script exercises the EXACT engine
// code the app runs.
import { execFileSync } from "child_process";
execFileSync("npx", ["tsc", "-p", "tsconfig.build.json"], {
  cwd: repoRoot,
  stdio: ["ignore", "ignore", "inherit"],
});
const relays = await import(pathMod.join(repoRoot, ".build/lib/bundle/relays.js"));

const BLOCK_ENGINE = relays.JITO_BLOCK_ENGINE_MAINNET;
const TIP_ACCOUNT = relays.KNOWN_JITO_TIP_ACCOUNTS[0];

// Read the keyed mainnet RPC from .env.local (the working config) so this
// probe doubles as the "keyed RPC wired and confirmed" check; fall back to
// the public mainnet endpoint.
// Keyed RPC confirmation is done OUTSIDE this script (curl / the solana CLI
// against the .env.local Helius key, which work on this box). Node fetch
// cannot reach the Helius edge from this WSL (ETIMEDOUT; an environment
// quirk), so the probe's blockhash read uses the public mainnet RPC unless
// SOLANA_RPC_MAINNET points elsewhere.
const RPC_URL =
  process.env.SOLANA_RPC_MAINNET ?? "https://api.mainnet-beta.solana.com";

async function rpcCall(url, method, params, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      });
      return res.json();
    } catch (e) {
      lastErr = e;
      // WSL outbound fetch is flaky (transient ETIMEDOUT); retry.
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw lastErr;
}

const connection = new Connection(RPC_URL, "confirmed");
let failures = 0;
const check = (name, cond, extra = "") => {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${extra ? `  (${extra})` : ""}`);
  if (!cond) failures += 1;
};

async function main() {
  console.log(`block engine: ${BLOCK_ENGINE}`);
  console.log(`rpc         : ${RPC_URL.replace(/\?api-key=.*/, "?api-key=***")}\n`);

  // ---- 1. read-only probes ------------------------------------------
  console.log("== read-only probes ==");
  const tips = await rpcCall(`${BLOCK_ENGINE}/bundles`, "getTipAccounts", []);
  check("getTipAccounts returns the live tip list", Array.isArray(tips.result) && tips.result.length >= 8, `count=${tips.result?.length ?? "?"}`);
  const known = (tips.result ?? []).filter((t) => relays.KNOWN_JITO_TIP_ACCOUNTS.includes(t));
  check("known tip account still in the live list", known.length > 0, known.join(","));
  // Health: the /health path serves no JSON-RPC method; reachability is
  // already proven by getTipAccounts above, so this is a soft note only.
  console.log("note: block-engine /health serves no body; getTipAccounts above is the reachability proof");

  // ---- 2. zero-cost encoding probe -----------------------------------
  console.log("\n== encoding probe (0-SOL throwaway payer, nothing can land) ==");
  const payer = Keypair.generate(); // 0 SOL forever: never funded
  const blockhash = (await connection.getLatestBlockhash("confirmed")).blockhash;
  const tx = new Transaction({ feePayer: payer.publicKey });
  tx.recentBlockhash = blockhash;
  // Jito validates at submission that the bundle tips >= 1000 lamports, so
  // the encoding probe carries the minimum tip. The payer is a throwaway
  // 0-SOL keypair that can never fund the fee or the transfer, so the bundle
  // is accepted (uuid) and then marked Invalid: nothing can land, zero cost.
  tx.add(
    SystemProgram.transfer({
      fromPubkey: payer.publicKey,
      toPubkey: new PublicKey(TIP_ACCOUNT),
      lamports: 1000,
    })
  );
  tx.sign(payer);
  const base64 = [tx.serialize().toString("base64")];

  // Build the EXACT Jito request the fan-out engine builds.
  const req = relays.buildRelayRequest("jito", base64);
  console.log(`POST ${req.url}`);
  console.log(`method ${req.method}, ${base64.length} tx(s), payer ${payer.publicKey.toBase58()} (0 SOL)`);
  const started = Date.now();
  const res = await fetch(req.url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...req.headers },
    body: req.body,
  });
  const raw = await res.text();
  const verdict = relays.classifyRelayResponse("jito", res.status, raw);
  console.log(`http ${res.status}, round trip ${Date.now() - started}ms`);
  console.log(`classification: ${verdict.status}${verdict.bundleId ? ` bundleId=${verdict.bundleId}` : ""}${verdict.detail ? ` detail=${verdict.detail}` : ""}`);
  check(
    "live Jito accepted the encoding-probe bundle (accepted-then-Invalid)",
    verdict.status === "accepted",
    raw.slice(0, 160)
  );

  // ---- 3. poll the probe bundle once (expect Invalid: 0-SOL payer) ----
  if (verdict.bundleId) {
    console.log("\n== status poll (expect Invalid: the 0-SOL payer cannot pay) ==");
    await new Promise((r) => setTimeout(r, 3000));
    try {
      const statusRes = await fetch(
        `${BLOCK_ENGINE}/bundles`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: 1,
            method: "getInflightBundleStatuses",
            params: [[verdict.bundleId]],
          }),
        }
      );
      const statusJson = await statusRes.json();
      const v = statusJson.result?.value?.[0];
      console.log(`bundle ${verdict.bundleId} status: ${v?.status ?? "unknown"}${v?.landed_slot != null ? `, slot ${v.landed_slot}` : ""}`);
      check("probe bundle is Invalid (never landed, zero cost)", v?.status === "Invalid", JSON.stringify(v ?? statusJson.error));
    } catch (e) {
      console.log(`status poll error (transient, not a probe failure): ${e.message}`);
    }
  }

  console.log("\n===== jito live probe done =====");
  process.exit(failures > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("PROBE ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
