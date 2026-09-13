#!/usr/bin/env node
// MAINNET sell-all BUNDLE test (PLAN-SELLALL-STAGE2-B.md work item 3).
//
// WHAT IT DOES (live): creates a SMALL, NON-GRADUATING coin (create_v2 + one
// small partial buy per roster wallet, via buildLaunchSequence with
// includeMigrate: false) so it stays on the pump.fun bonding curve, then runs
// the sell-all with `submit: "bundle"` and prints the same on-chain tx-hash
// sweep the devnet runner prints. The bundle is the CURVE leg (the mainnet
// pre-migration rehearsal for the atomic relay path).
//
// DANGER: a live run spends REAL SOL on mainnet. It refuses to do anything
// destructive unless BOTH `--yes` AND `--i-understand-this-spends-real-sol`
// are present, and it refuses a non-mainnet RPC. Without both flags it only
// prints the roster balances + a total-SOL estimate and STOPS (dry run).
//
// USAGE:
//   node scripts/mainnet-sellall-test.mjs --wallets <path>                 # dry run
//   node scripts/mainnet-sellall-test.mjs --wallets <path> --yes \
//       --i-understand-this-spends-real-sol [--rpc <mainnet-url>] [--origin <url>]
//
// KEYS: --wallets is the ONLY key material this script reads. It never
// generates a WALLET keypair, never reads a key it was not given, and never
// writes a key anywhere. (The ephemeral mint keypair created by the library is
// in memory only and is never written.) Secrets are never printed.
//
// RELAY PROXY: `submitBundleViaFanoutWithRetry` POSTs to the SAME-ORIGIN
// relative path /api/bundle-relay (the Next route that holds the relay
// credentials server-side). A bare Node script cannot fetch a relative URL,
// so this script wraps globalThis.fetch to resolve `/api/...` against
// --origin (default http://127.0.0.1:3000). Point it at a running app origin
// that has NEXTBLOCK_API_KEY / ASTRALANE_API_KEY / BLOXROUTE_JWT configured.
//
// This file is a test tool and is deliberately NOT run by the gates.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

net.setDefaultAutoSelectFamily(false);

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// MAINNET, forced BEFORE the compiled lib reads the cluster flag (lib/network.ts
// reads process.env at call time), so .env.local does not have to be flipped.
process.env.NEXT_PUBLIC_SOLANA_NETWORK = "mainnet";

const DEFAULT_MAINNET_RPC =
  process.env.NEXT_PUBLIC_SOLANA_RPC_MAINNET ||
  "https://api.mainnet-beta.solana.com";

/** Small partial buy per wallet (0.02 SOL): enough to cover the Token-2022
 *  ATA rent + fee, never enough to graduate the curve. */
const SMALL_BUY_LAMPORTS = BigInt("20000000");
/** Conservative create_v2 rent + account overhead. */
const CREATE_OVERHEAD_LAMPORTS = BigInt("30000000");
/** Token-2022 ATA rent estimate (170-byte account). */
const ATA_RENT_ESTIMATE = BigInt("2100000");
const TX_FEE = BigInt("5000");
/** Helius Sender SWQOS tip (mainnet create/buy path). */
const SENDER_TIP = BigInt("5000");
/** Relay bundle tip floor (DEFAULT_JITO_TIP_LAMPORTS). */
const RELAY_TIP = BigInt("1000000");

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}

function has(name) {
  return process.argv.includes(name);
}

function expandHome(p) {
  if (!p) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

function solStr(lamports) {
  return `${(Number(lamports) / 1_000_000_000).toFixed(6)} SOL`;
}

function assert(cond, msg) {
  if (!cond) throw new Error(`ASSERTION FAILED: ${msg}`);
}

function hostOf(rpc) {
  try {
    return new URL(rpc).host;
  } catch {
    return rpc;
  }
}

/* ------------------------------------------------------------------ */
/* build + module loading                                              */
/* ------------------------------------------------------------------ */

/** Every compiled module this runner requires, mapped to its source. */
const REQUIRED_BUILD_MODULES = [
  ["lib/pump.ts", "lib/pump.js"],
  ["lib/migrate.ts", "lib/migrate.js"],
  ["lib/bundle/launch.ts", "lib/bundle/launch.js"],
  ["lib/bundle/protected-send.ts", "lib/bundle/protected-send.js"],
  ["lib/sell-all.ts", "lib/sell-all.js"],
];

/** Fails loudly when a required .build/lib/ output is missing or stale. */
function assertFreshBuildModules() {
  for (const [srcRel, outRel] of REQUIRED_BUILD_MODULES) {
    const src = path.join(repoRoot, srcRel);
    const out = path.join(repoRoot, ".build", outRel);
    if (!fs.existsSync(out)) {
      throw new Error(`stale .build/: missing ${outRel} (compiled from ${srcRel})`);
    }
    if (fs.statSync(out).mtimeMs < fs.statSync(src).mtimeMs) {
      throw new Error(`stale .build/: ${outRel} is older than its source ${srcRel}`);
    }
  }
}

/** Always recompiles the lib to .build/ (never trust an existing tree). */
function compileBuild() {
  execFileSync(
    process.platform === "win32" ? "npx.cmd" : "npx",
    ["tsc", "-p", "tsconfig.build.json"],
    { cwd: repoRoot, stdio: ["ignore", "inherit", "inherit"] }
  );
  assertFreshBuildModules();
}

function loadModules() {
  const web3 = require("@solana/web3.js");
  const bs58mod = require("bs58");
  const bs58 = bs58mod.default ?? bs58mod;
  const pump = require(path.join(repoRoot, ".build/lib/pump.js"));
  const migrate = require(path.join(repoRoot, ".build/lib/migrate.js"));
  const launch = require(path.join(repoRoot, ".build/lib/bundle/launch.js"));
  const protectedSend = require(
    path.join(repoRoot, ".build/lib/bundle/protected-send.js")
  );
  const sellAll = require(path.join(repoRoot, ".build/lib/sell-all.js"));
  return { ...web3, bs58, pump, migrate, launch, protectedSend, sellAll };
}

function keypairFromBase58(bs58, s) {
  return require("@solana/web3.js").Keypair.fromSecretKey(bs58.decode(s.trim()));
}

/** JSON byte array / {secretKey:[...]} / bare base58. Reads ONLY the given file. */
function loadWallets(bs58, p) {
  const raw = JSON.parse(fs.readFileSync(expandHome(p), "utf8"));
  const list = Array.isArray(raw) ? raw : raw.wallets;
  if (!Array.isArray(list) || list.length === 0) {
    throw new Error(`wallet roster ${p} must be a non-empty array`);
  }
  return list
    .map((w, i) => ({
      label: w.label ?? `wallet-${String(i + 1).padStart(2, "0")}`,
      pubkey: w.pubkey ?? w.address ?? w.publicKey,
      secret: w.secret ?? w.key ?? w.privateKey,
    }))
    .filter((w) => w.pubkey && w.secret)
    .slice(0, 4); // one tx per wallet; the active relays cap a bundle at 4 txs
}

/** Resolves relative /api/... URLs (the same-origin relay proxy) against the
 *  app origin; absolute URLs pass straight through. */
function installOriginFetch(origin) {
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    if (typeof input === "string" && input.startsWith("/")) {
      return nativeFetch(`${origin}${input}`, init);
    }
    return nativeFetch(input, init);
  };
}

/* ------------------------------------------------------------------ */
/* on-chain hash sweep (same shape as the devnet runner)               */
/* ------------------------------------------------------------------ */

/** The complete on-chain hash log for a run window: FAILED txs included, and
 *  every tx the run signed without logging. Deduped by signature. */
async function sweepRunTxs(mods, connection, addrs, slotMin, slotMax) {
  const seen = new Map();
  for (const a of addrs) {
    let sigs = [];
    try {
      sigs = await connection.getSignaturesForAddress(
        new mods.PublicKey(a.pubkey),
        { limit: 60 }
      );
    } catch (e) {
      console.log(`  sweep: ${a.label} read failed (${e.message})`);
      continue;
    }
    for (const s of sigs) {
      if (s.slot < slotMin || s.slot > slotMax) continue;
      const row = seen.get(s.signature) ?? { slot: s.slot, err: s.err, wallets: [] };
      if (!row.wallets.includes(a.label)) row.wallets.push(a.label);
      seen.set(s.signature, row);
    }
  }
  const rows = [...seen.entries()].sort((x, y) => x[1].slot - y[1].slot);
  const failed = rows.filter(([, r]) => r.err).length;
  console.log(
    `\n=== ALL TX HASHES, slots ${slotMin}..${slotMax} — ${rows.length} transactions ===`
  );
  for (const [sig, r] of rows) {
    let ixs = [];
    try {
      const tx = await connection.getTransaction(sig, {
        maxSupportedTransactionVersion: 0,
      });
      ixs = (tx?.meta?.logMessages ?? [])
        .filter((l) => l.startsWith("Program log: Instruction: "))
        .map((l) => l.slice("Program log: Instruction: ".length));
    } catch {
      // instruction labels are best-effort; hash + status still print
    }
    const status = r.err === null ? "OK " : `ERR ${JSON.stringify(r.err)}`;
    console.log(
      `${r.slot}  ${status}  ${r.wallets.join(",")}  ${ixs.join("|")}  ${sig}`
    );
    console.log(`    https://solscan.io/tx/${sig}`);
  }
  console.log(`=== end tx hash log: ${rows.length} hashes, ${failed} failed ===`);
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

async function main() {
  const rpc = arg("--rpc", DEFAULT_MAINNET_RPC);
  const walletsPath = arg("--wallets", "");
  const origin = arg("--origin", "http://127.0.0.1:3000").replace(/\/+$/, "");
  const yes = has("--yes");
  const understand = has("--i-understand-this-spends-real-sol");
  const live = yes && understand;

  console.log("=== MAINNET sell-all BUNDLE test (SPENDS REAL SOL WHEN LIVE) ===");
  console.log(`rpc=${rpc}`);
  console.log(`mode=${live ? "LIVE (--yes + --i-understand-this-spends-real-sol)" : "DRY RUN"}`);

  // Guard 1: mainnet only, checked before ANY network call.
  const host = hostOf(rpc);
  if (/devnet|local|testnet|127\.0\.0\.1|localhost/i.test(host)) {
    throw new Error(
      `refusing to run against non-mainnet RPC host "${host}" — this script spends real SOL on mainnet`
    );
  }

  // Guard 2: the roster path is the only key input; it is mandatory.
  if (!walletsPath) {
    throw new Error(
      "--wallets <path> is required (this script never generates or invents a wallet key)"
    );
  }

  const web3 = require("@solana/web3.js");
  const bs58mod = require("bs58");
  const bs58 = bs58mod.default ?? bs58mod;
  const { Connection, PublicKey } = web3;

  const roster = loadWallets(bs58, walletsPath);
  assert(roster.length >= 1, "wallet roster produced no usable wallets");
  const connection = new Connection(rpc, "confirmed");

  // Print the roster balances + a total-SOL estimate BEFORE doing anything.
  console.log(`roster (${roster.length} keys):`);
  let totalNeeded = CREATE_OVERHEAD_LAMPORTS + RELAY_TIP;
  for (const w of roster) {
    const bal = BigInt(await connection.getBalance(new PublicKey(w.pubkey), "confirmed"));
    const need = SMALL_BUY_LAMPORTS + ATA_RENT_ESTIMATE + TX_FEE + SENDER_TIP;
    totalNeeded += need;
    console.log(
      `  ${w.label} ${w.pubkey} balance=${solStr(bal)} needs~${solStr(need)} ${
        bal < need ? `SHORT ${solStr(need - bal)}` : "ok"
      }`
    );
  }
  console.log(
    `total-SOL estimate: ~${solStr(totalNeeded)} (create ~${solStr(
      CREATE_OVERHEAD_LAMPORTS
    )} + ${roster.length} small buys of ~${solStr(SMALL_BUY_LAMPORTS)} + rent/fees + relay tip ${solStr(
      RELAY_TIP
    )})`
  );

  if (!live) {
    console.log(
      "\nDRY RUN — refusing to create or sell without BOTH --yes and --i-understand-this-spends-real-sol. Nothing was sent."
    );
    return;
  }

  // Everything below spends SOL. Compile + load the lib only now.
  compileBuild();
  const mods = loadModules();
  installOriginFetch(origin);
  console.log(`relay proxy origin -> ${origin}`);

  const creator = keypairFromBase58(mods.bs58, roster[0].secret);
  const mintKeypair = mods.Keypair.generate(); // ephemeral, in memory only
  const sweepAddrs = [
    { label: "creator", pubkey: creator.publicKey.toBase58() },
    ...roster.map((w) => ({ label: w.label, pubkey: w.pubkey })),
  ];
  const slotBefore = await connection.getSlot("confirmed");
  let mint = null;

  try {
    // 1) create_v2 + a small partial buy per wallet, NO migrate. The library's
    //    final buy is forced to graduate the curve, so its buy txs are
    //    discarded and this script sends its OWN small buys to stay
    //    pre-migration.
    const seq = await mods.launch.buildLaunchSequence({
      connection,
      creator,
      name: "SellAll Bundle Test",
      symbol: "SABT",
      uri: "https://example.com/sellall-bundle-test.json",
      buys: roster.map((w) => ({
        wallet: keypairFromBase58(mods.bs58, w.secret),
        solInLamports: SMALL_BUY_LAMPORTS,
      })),
      mintKeypair,
      includeMigrate: false,
    });
    mint = seq.pda.mint;
    console.log(`mint=${mint.toBase58()}`);

    const createRes = await mods.protectedSend.sendProtectedTx(
      connection,
      seq.createTx,
      [creator, mintKeypair],
      { skipPriorityFeeIx: true, label: "create_v2", confirmTimeoutMs: 120_000 }
    );
    console.log(`create_v2 sig=${createRes.signature}`);

    const feeRecipient = await mods.pump.resolvePumpFeeRecipient(connection);
    for (const w of roster) {
      const kp = keypairFromBase58(mods.bs58, w.secret);
      const cur = await mods.pump.readPumpCurveState(connection, mint);
      assert(cur.kind === "ok", `curve missing before ${w.label} buy`);
      const q = mods.pump.quotePumpBuy({
        solInLamports: SMALL_BUY_LAMPORTS,
        virtualSolReserves: cur.curve.virtualSolReserves,
        virtualTokenReserves: cur.curve.virtualTokenReserves,
      });
      const ixs = mods.pump.buildPumpBuyIx({
        mint,
        buyer: kp.publicKey,
        creator: cur.curve.creator,
        feeRecipient,
        tokensOut: q.tokensOut,
        maxSolCost: q.maxSolCost,
      });
      const tx = new mods.Transaction({ feePayer: kp.publicKey });
      tx.add(
        mods.ComputeBudgetProgram.setComputeUnitLimit({ units: 250_000 })
      );
      tx.add(...ixs);
      const r = await mods.protectedSend.sendProtectedTx(connection, tx, [kp], {
        label: `buy ${w.label}`,
        confirmTimeoutMs: 120_000,
      });
      console.log(`buy ${w.label} sig=${r.signature}`);
    }

    const post = await mods.pump.readPumpCurveState(connection, mint);
    assert(post.kind === "ok", "curve missing after buys");
    assert(
      post.curve.complete === false,
      "coin graduated — this test needs a pre-migration curve coin"
    );
    console.log(
      `curve complete=${post.curve.complete} realTokenReserves=${post.curve.realTokenReserves}`
    );

    // 2) the sell-all BUNDLE (mainnet only; the curve leg here).
    const report = await mods.sellAll.sellAllManagedWallets({
      connection,
      mint,
      wallets: roster.map((w) => ({ address: w.pubkey, key: w.secret })),
      slippagePct: 5,
      submit: "bundle",
    });
    console.log(
      `sell-all route=${report.route} sold=${report.sold}/${report.total} skipped=${report.skipped} failed=${report.failed}`
    );
    for (const o of report.outcomes) {
      console.log(
        `  ${o.address} ${o.status}${o.reason ? ` (${o.reason})` : ""}${
          o.signature ? ` ${o.signature}` : ""
        }`
      );
    }
  } finally {
    const slotAfter = await connection.getSlot("confirmed");
    await sweepRunTxs(mods, connection, sweepAddrs, slotBefore, slotAfter + 2);
  }
}

main().catch((e) => {
  console.error("\nERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
