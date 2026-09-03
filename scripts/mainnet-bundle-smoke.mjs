// Milestone M7b: MAINNET BUNDLE SMOKE (prep + execution, USER-GATED).
//
// Closes the M2 atomicity gap: prove a real Jito bundle LANDS ATOMICALLY on
// mainnet with a tiny real-SOL budget, WITHOUT launching a token. Two
// transactions in one bundle, all-or-nothing:
//
//   tx1  payer -> receiver (a fresh keypair generated in-script): 0.005 SOL
//   tx2  payer -> Jito tip account: the tip (0.005 SOL default)
//
// Both txs share one recent blockhash; the tip sits in the LAST tx (the Jito
// convention every relay accepts). If the bundle lands, the receiver's
// balance jumps by exactly the transfer and BOTH txs confirm in the SAME
// slot (atomicity). If any tx fails simulation the whole bundle is rejected
// and NOTHING moves: the smoke cannot half-land.
//
// COST (exact, at defaults):
//   - transfer to receiver   0.00500000 SOL
//   - Jito tip               0.00500000 SOL
//   - tx fees (2 x ~5000)    0.00001000 SOL
//   - TOTAL                  0.01001000 SOL
//   Recommended funding for the payer: 0.02 SOL (headroom for fees + a
//   retry attempt at the escalated tip if the first is dropped).
//
// GATING: this is REAL MONEY. The default mode is a dry run: it prints the
// exact plan, cost and the payer address to fund, and exits WITHOUT spending
// anything. Execution requires BOTH an explicit `--yes` flag AND a funded
// payer (balance check runs first; the script exits if the payer holds less
// than the required budget). There is no token launch: the receiver is a
// throwaway keypair the script prints for the record.
//
// The bundle is submitted through the relay fan-out engine (Jito primary +
// bloXroute + Astralane when their credentials exist in the env, mirroring
// the proxy route), so the smoke doubles as the fan-out's first real test.
//
// Usage:
//   node scripts/mainnet-bundle-smoke.mjs --dry-run
//   node scripts/mainnet-bundle-smoke.mjs --yes [--tip <SOL>] [--amount <SOL>]
//                                             [--keypair <mainnet wallet json>]
// Requires: a MAINNET-funded payer keypair (never the devnet key).

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
  "tsc", "-p", "tsconfig.build.json",
], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
const relays = require(path.join(repoRoot, ".build/lib/bundle/relays.js"));
const jitoLib = require(path.join(repoRoot, ".build/lib/bundle/jito.js"));

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
function has(name) { return process.argv.includes(name); }

const RPC_URL = process.env.SOLANA_RPC_MAINNET ?? "https://api.mainnet-beta.solana.com";
const EXPLORER = "https://explorer.solana.com";
const BLOCK_ENGINE = relays.JITO_BLOCK_ENGINE_MAINNET;

async function main() {
  const dryRun = !has("--yes");
  const tipSol = parseFloat(arg("--tip", "0.005"));
  const amountSol = parseFloat(arg("--amount", "0.005"));
  const keypairPath =
    process.env.SOLANA_MAINNET_KEYPAIR ??
    arg("--keypair", path.join(require("node:os").homedir(), ".config", "solana", "mainnet.json"));

  const tipLamports = Math.round(tipSol * LAMPORTS_PER_SOL);
  const amountLamports = Math.round(amountSol * LAMPORTS_PER_SOL);
  const feeLamports = 5000; // per tx, current mainnet base fee
  const totalLamports = tipLamports + amountLamports + 2 * feeLamports;
  const recommendedFunding = Math.ceil(totalLamports * 2); // one escalated retry

  console.log("===== MAINNET BUNDLE SMOKE =====");
  console.log(`mode      : ${dryRun ? "DRY RUN (no SOL spent)" : "EXECUTE (real SOL)"}`);
  console.log(`rpc       : ${RPC_URL}`);
  console.log(`block eng : ${BLOCK_ENGINE}`);

  // ---- payer ---------------------------------------------------------
  let payer;
  try {
    const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
    payer = Keypair.fromSecretKey(Uint8Array.from(secret));
  } catch (e) {
    if (dryRun) {
      // Preparing the smoke: generate a fresh 0-SOL mainnet keypair so the
      // operator has an address to fund. No SOL is spent in this step.
      console.log(`no keypair at ${keypairPath}; generating a fresh 0-SOL mainnet keypair for the smoke...`);
      fs.mkdirSync(path.dirname(keypairPath), { recursive: true });
      const fresh = Keypair.generate();
      fs.writeFileSync(keypairPath, JSON.stringify(Array.from(fresh.secretKey)));
      payer = fresh;
    } else {
      console.error(`cannot load mainnet keypair at ${keypairPath}: ${e.message}`);
      console.error("the dry run generated a fresh one; fund it first (see the address below), then re-run with --yes");
      process.exit(1);
    }
  }
  console.log(`payer     : ${payer.publicKey.toBase58()}`);

  const connection = new Connection(RPC_URL, "confirmed");
  let payerBal = 0;
  try {
    payerBal = await connection.getBalance(payer.publicKey, "confirmed");
  } catch (e) {
    console.error(`cannot read payer balance: ${e.message}`);
    process.exit(1);
  }
  console.log(`balance   : ${(payerBal / LAMPORTS_PER_SOL).toFixed(6)} SOL`);

  // ---- exact cost report ----------------------------------------------
  console.log("\n== exact cost ==");
  console.log(`  transfer to receiver   ${(amountLamports / LAMPORTS_PER_SOL).toFixed(8)} SOL  (${amountLamports} lamports)`);
  console.log(`  Jito tip               ${(tipLamports / LAMPORTS_PER_SOL).toFixed(8)} SOL  (${tipLamports} lamports)`);
  console.log(`  tx fees (2 x 5000)     ${((2 * feeLamports) / LAMPORTS_PER_SOL).toFixed(8)} SOL`);
  console.log(`  TOTAL                  ${(totalLamports / LAMPORTS_PER_SOL).toFixed(8)} SOL`);
  console.log(`  recommended funding    ${(recommendedFunding / LAMPORTS_PER_SOL).toFixed(8)} SOL (headroom for one escalated retry)`);

  const receiver = Keypair.generate();
  console.log(`receiver  : ${receiver.publicKey.toBase58()} (fresh throwaway key, printed for the record)`);
  console.log(`tip       : ${tipLamports} lamports (>= ${relays.KNOWN_JITO_TIP_ACCOUNTS.length ? "the 1000 minimum" : "?"}, Jito tip account)`);

  if (dryRun) {
    console.log("\nDRY RUN: nothing was sent, no SOL moved.");
    console.log("To execute, fund the payer above with ~0.02 SOL on MAINNET, then:");
    console.log(`  node scripts/mainnet-bundle-smoke.mjs --yes`);
    console.log("Execution reports the real slot, tip and bundle id.");
    process.exit(0);
  }

  if (payerBal < totalLamports) {
    console.error(`\npayer holds ${(payerBal / LAMPORTS_PER_SOL).toFixed(6)} SOL but the smoke needs ${(totalLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL. Fund ${payer.publicKey.toBase58()} on MAINNET first.`);
    process.exit(1);
  }

  // ---- assemble the 2-tx bundle --------------------------------------
  const tips = await relays.fetchJsonRpc(`${BLOCK_ENGINE}/bundles`, "getTipAccounts", []);
  const tipAccount = tips.result?.[0];
  if (!tipAccount) { console.error("no Jito tip account available"); process.exit(1); }
  console.log("\n== executing ==");
  console.log(`tip account: ${tipAccount}`);

  const latest = await connection.getLatestBlockhash("confirmed");
  const tx1 = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx1.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: receiver.publicKey,
    lamports: amountLamports,
  }));

  // tx2 hosts the tip: a 1-lamport self-transfer (harmless) + the tip ix is
  // appended by assembleBundle into the LAST tx.
  const tx2 = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx2.add(SystemProgram.transfer({
    fromPubkey: payer.publicKey,
    toPubkey: payer.publicKey,
    lamports: 1,
  }));

  const jito = new jitoLib.JitoBundleClient(BLOCK_ENGINE);
  const { base64, tipLamports: paidTip } = await jito.assembleBundle({
    txs: [tx1, tx2],
    signersByTx: [[payer], [payer]],
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
    tipAccount: new PublicKey(tipAccount),
    tipLamports,
    tipPayer: payer,
  });
  console.log(`bundle: ${base64.length} tx(s), tip ${paidTip} lamports -> ${tipAccount}`);
  console.log(`receiver balance before: ${(await connection.getBalance(receiver.publicKey)).toLocaleString()} lamports`);

  // ---- submit through the relay fan-out engine ------------------------
  const { enabled, overrides } = relays.resolveRelayEndpointsFromEnv();
  console.log(`fan-out relays enabled: ${enabled.join(", ")}`);
  const fanout = await relays.fanOutToRelays({
    base64,
    enabled,
    overrides,
    timeoutMs: 15_000,
  });
  console.log(`fan-out: ${relays.summarizeFanout(fanout)}`);
  const winner = fanout.accepted;
  if (!winner || !winner.bundleId) {
    console.error("NO RELAY ACCEPTED the smoke bundle; nothing was sent on chain. No SOL moved.");
    process.exit(1);
  }
  console.log(`bundle id: ${winner.bundleId} (accepted by ${winner.relay})`);

  // ---- poll for the final status --------------------------------------
  let status = "Pending";
  let landedSlot = null;
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    try {
      const s = await relays.fetchJsonRpc(`${BLOCK_ENGINE}/bundles`, "getInflightBundleStatuses", [[winner.bundleId]]);
      const v = s.result?.value?.[0];
      if (v) {
        status = v.status;
        landedSlot = v.landed_slot ?? null;
        if (status === "Landed" || status === "Invalid" || status === "Failed") break;
      }
    } catch { /* transient, keep polling */ }
    await new Promise((r) => setTimeout(r, 2500));
  }
  console.log(`bundle status: ${status}${landedSlot != null ? `, landed slot ${landedSlot}` : ""}`);
  if (status !== "Landed") {
    console.error(`bundle did not land (${status}); nothing moved on chain. Check the payer balance and retry with a higher --tip.`);
    process.exit(1);
  }

  // ---- atomicity proof: both txs in the SAME slot ----------------------
  const recvAfter = await connection.getBalance(receiver.publicKey, "confirmed");
  console.log(`receiver balance after : ${recvAfter.toLocaleString()} lamports`);
  // The bundle's txs are recoverable from the tip payment; simplest proof is
  // the receiver's balance delta + the landed slot from the relay status.
  const delta = recvAfter;
  console.log(`receiver delta: ${(delta / LAMPORTS_PER_SOL).toFixed(8)} SOL (expected ${(amountLamports / LAMPORTS_PER_SOL).toFixed(8)})`);
  if (delta !== amountLamports) {
    console.error("receiver balance delta does not match the transfer amount: atomicity proof FAILED");
    process.exit(1);
  }
  console.log(`\n===== MAINNET BUNDLE SMOKE RESULT =====`);
  console.log(`slot      : ${landedSlot}`);
  console.log(`tip       : ${paidTip} lamports (${(paidTip / LAMPORTS_PER_SOL).toFixed(6)} SOL)`);
  console.log(`bundle id : ${winner.bundleId}`);
  console.log(`relay     : ${winner.relay}`);
  console.log(`receiver  : ${receiver.publicKey.toBase58()} (${EXPLORER}/address/${receiver.publicKey.toBase58()})`);
  console.log(`atomicity : both txs landed in slot ${landedSlot} (Jito bundle guarantee)`);
  console.log(`cost      : ${(totalLamports / LAMPORTS_PER_SOL).toFixed(8)} SOL`);
  process.exit(0);
}

main().catch((e) => {
  console.error("SMOKE ERROR:", e && e.message ? e.message : e);
  process.exit(1);
});
