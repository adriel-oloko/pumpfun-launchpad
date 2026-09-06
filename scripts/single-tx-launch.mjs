// Single-transaction token launch via NextBlock /api/v2/submit (option 2).
//
// Launches a REAL pump.fun token in ONE transaction: create_v2 + one buy +
// the NextBlock tip, packed into a versioned (V0) tx that fits the 1232-byte
// limit via the shared pump.fun address lookup table (lib/bundle/lookup.ts).
// Submitted to NextBlock's SINGLE-submit endpoint (not the 2-4 tx bundle), so
// it slots into the free tier's 1 TX / 10s.
//
// GATING: this is REAL MONEY (mainnet). The default mode is a dry run: it
// prints the exact plan, the measured tx size and the buyer address to fund,
// and exits WITHOUT spending anything. Execution requires BOTH `--yes` AND a
// funded buyer (the creator pays fees + tip; the buyer must hold its own buy
// SOL — there is no room for a funding transfer inside a single tx).
//
// COST (approx, at defaults): buy 0.01 SOL + tip 0.001 SOL + one-time ALT
// create/extend ~0.01 SOL + tx fees. The creator pays the tip + ALT + fees;
// the buyer pays its own buy + fee.
//
// WSL note: node's fetch (undici) can hang on the dead IPv6 route. If the RPC
// or submit hangs, run with:
//   NODE_OPTIONS="--require /tmp/disable-afs.js" node scripts/single-tx-launch.mjs ...
// where /tmp/disable-afs.js = `require('net').setDefaultAutoSelectFamily(false);`
//
// Usage:
//   node scripts/single-tx-launch.mjs --private-key <base58>            # dry run
//   node scripts/single-tx-launch.mjs --creator <funded-mainnet-keypair.json>
//   node scripts/single-tx-launch.mjs --private-key <base58> --yes \
//       --name "Test" --symbol "TST" --buy-sol 0.01 --tip-sol 0.001
// The wallet may be given as --private-key <base58> or --creator <file> where
// the file is a JSON byte array, {secretKey:[...]}, or a bare base58 string.
// Requires: NEXTBLOCK_API_KEY (env), a funded creator, and (unless self-buy) a
// funded buyer.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Compile the TS lib to .build/ (same recipe as scripts/mainnet-bundle-smoke.mjs).
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
  "tsc",
  "-p",
  "tsconfig.build.json",
], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });

const {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} = require("@solana/web3.js");
const _bs58 = require("bs58");
const bs58 = _bs58.default ?? _bs58; // bs58 v6 is ESM: require() -> { default: {...} }
const singleTx = require(path.join(repoRoot, ".build/lib/bundle/single-tx.js"));
const lookup = require(path.join(repoRoot, ".build/lib/bundle/lookup.js"));
const pump = require(path.join(repoRoot, ".build/lib/pump.js"));
const relays = require(path.join(repoRoot, ".build/lib/bundle/relays.js"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
function has(name) {
  return process.argv.includes(name);
}

/** Minimal .env / .env.local loader (no dotenv dependency). Loads KEY=value
 *  lines from `.env` then `.env.local` (so .env.local wins over .env), but
 *  never overrides anything already set in the shell environment. */
function loadDotEnv() {
  const preexisting = new Set(Object.keys(process.env));
  for (const name of [".env", ".env.local"]) {
    const p = path.join(repoRoot, name);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split("\n")) {
      const t = line.trim();
      if (!t || t.startsWith("#")) continue;
      const eq = t.indexOf("=");
      if (eq === -1) continue;
      const key = t.slice(0, eq).trim();
      let val = t.slice(eq + 1).trim();
      if (
        (val.startsWith('"') && val.endsWith('"')) ||
        (val.startsWith("'") && val.endsWith("'"))
      ) {
        val = val.slice(1, -1);
      }
      if (key && !preexisting.has(key)) process.env[key] = val;
    }
  }
}
loadDotEnv();

const RPC_URL =
  process.env.SOLANA_RPC_MAINNET ?? "https://api.mainnet-beta.solana.com";
const API_KEY = process.env.NEXTBLOCK_API_KEY ?? "";
const BASE_URL = process.env.NEXTBLOCK_URL ?? "https://ny.nextblock.io";
const EXPLORER = "https://explorer.solana.com";

/** Reconstructs a keypair from a base58 private-key string. */
function keypairFromBase58(s) {
  return Keypair.fromSecretKey(bs58.decode(s.trim()));
}

/** Loads a keypair from a file. Accepts a JSON byte array (`[1,2,...]`), an
 *  object (`{"secretKey":[1,2,...]}`), or a plain base58 private-key string
 *  (one line, no JSON). */
function loadKeypair(p) {
  const raw = fs.readFileSync(p, "utf8").trim();
  try {
    const j = JSON.parse(raw);
    if (typeof j === "string") return keypairFromBase58(j);
    const bytes = Array.isArray(j) ? j : j.secretKey;
    return Keypair.fromSecretKey(Uint8Array.from(bytes));
  } catch {
    return keypairFromBase58(raw);
  }
}

async function main() {
  const dryRun = !has("--yes");
  if (!API_KEY) {
    console.error("NEXTBLOCK_API_KEY is not set (server env, never NEXT_PUBLIC_).");
    process.exit(1);
  }
  const privKey = arg("--private-key", "");
  const creatorPath = arg("--creator", "");
  if (!privKey && !creatorPath) {
    console.error(
      "provide the wallet via --private-key <base58> or --creator <path-to-keypair-file> (funded mainnet wallet)."
    );
    process.exit(1);
  }
  const creator = privKey ? keypairFromBase58(privKey) : loadKeypair(creatorPath);
  const buyer = has("--buyer") ? loadKeypair(arg("--buyer", "")) : creator;
  const buyerIsCreator = buyer.publicKey.equals(creator.publicKey);

  const name = arg("--name", "Single Tx Test");
  const symbol = arg("--symbol", "STX");
  const uri = arg("--uri", "https://example.com/metadata.json");
  const buySol = parseFloat(arg("--buy-sol", "0.01"));
  const tipSol = parseFloat(arg("--tip-sol", "0.001"));
  const solInLamports = BigInt(Math.round(buySol * LAMPORTS_PER_SOL));
  const tipLamports = Math.round(tipSol * LAMPORTS_PER_SOL);

  const connection = new Connection(RPC_URL, "confirmed");
  const feeRecipient = await pump.resolvePumpFeeRecipient(connection);
  const tipAccount = new PublicKey(relays.KNOWN_NEXTBLOCK_TIP_ACCOUNTS[0]);

  console.log("=== SINGLE-TX LAUNCH PLAN ===");
  console.log(`creator : ${creator.publicKey.toBase58()}`);
  console.log(
    `buyer   : ${buyer.publicKey.toBase58()}${buyerIsCreator ? " (creator self-buy)" : ""}`
  );
  console.log(`token   : ${name} (${symbol})`);
  console.log(`uri     : ${uri}`);
  console.log(`buy     : ${buySol} SOL (${solInLamports} lamports)`);
  console.log(`tip     : ${tipSol} SOL -> ${tipAccount.toBase58()}`);
  console.log(`fee rec : ${feeRecipient.toBase58()}`);

  // Size check with a synthetic ALT (no on-chain spend) so even the dry run
  // proves the tx fits before any money moves.
  const syntheticAlt = lookup.syntheticPumpLookupTable(
    feeRecipient,
    creator.publicKey
  );
  const built = await singleTx.buildSingleTxLaunch({
    connection,
    creator,
    name,
    symbol,
    uri,
    buyer,
    solInLamports,
    tipAccount,
    tipLamports,
    alt: syntheticAlt,
  });
  console.log(`built   : ${built.sizeBytes} bytes (limit 1232)`);
  console.log(`mint    : ${built.mint.toBase58()} (generated this run)`);

  const altCost = 0.0105; // one-time create + extend lookup table (approx)
  const total = buySol + tipSol + altCost + 0.001;
  console.log(`est. spend: ~${total.toFixed(6)} SOL (buy + tip + one-time ALT + fees)`);
  console.log(
    `buyer must hold >= ${(buySol + 0.002).toFixed(6)} SOL before execution`
  );

  if (dryRun) {
    console.log("\nDRY RUN — nothing sent. Re-run with --yes to execute.");
    return;
  }

  const { account: alt } = await lookup.ensurePumpLookupTable(connection, creator);
  const live = await singleTx.buildSingleTxLaunch({
    connection,
    creator,
    name,
    symbol,
    uri,
    buyer,
    solInLamports,
    tipAccount,
    tipLamports,
    alt,
  });
  console.log(`built (live): ${live.sizeBytes} bytes`);
  console.log(`submitting to ${BASE_URL}/api/v2/submit ...`);
  const { signature } = await singleTx.submitSingleTxToNextBlock({
    base64: live.base64,
    apiKey: API_KEY,
    baseUrl: BASE_URL,
  });
  console.log(`SUBMITTED: ${signature}`);
  console.log(`explorer : ${EXPLORER}/tx/${signature}`);
  console.log(`mint     : ${live.mint.toBase58()}`);
  console.log(
    "NextBlock returns no status — verify landing on-chain (the mint appearing)."
  );
}

main().catch((e) => {
  console.error("ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
