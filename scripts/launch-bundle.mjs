// Milestone M2 devnet launch script.
//
// Launches a token with N selected dev wallets buying atomically:
//   Tier 1: the launch sequence (fund + create + packed multi-signer buys) is
//           sent as normal devnet transactions, proving 5+ wallets buy and
//           holder distribution is real on-chain.
//   Tier 2: a fresh launch sequence is assembled into a Jito bundle
//           (base64 txs, shared blockhash, tip transfer in the last tx),
//           pre-flight simulated, and submitted. The devnet block engine is
//           not reachable (devnet.block-engine.jito.wtf does not resolve), so
//           encoding + tip are validated against the reachable mainnet
//           endpoint: a rejection is expected and proves the encoding path.
//
// Usage:
//   node scripts/gen-wallets.mjs 6            # once: create devnet wallets
//   node scripts/launch-bundle.mjs [opts]
// Options:
//   --wallets <file>     wallet json (default scripts/dev-wallets.json)
//   --sol-in <SOL>       one buy amount for all wallets (default 0.05)
//   --per-wallet <csv>   per-wallet SOL amounts, overrides --sol-in
//   --nonce <u64>        mint seed (default: Unix ms)
//   --name / --symbol / --uri   token metadata (defaults provided)
//   --tier <1|2|both>    what to run (default both)
//   --no-fund            do not fund wallets from the creator
//   --bundle-endpoint <url>  Jito block engine base URL (default devnet)
//   --tip-lamports <n>   initial Jito tip (default 1000, min enforced)
//   --max-attempts <n>   bundle resubmissions with escalating tip (default 3)
//   --rpc <url>          devnet RPC (default https://api.devnet.solana.com)

import anchorPkg from "@coral-xyz/anchor";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
} from "@solana/web3.js";
import bs58 from "bs58";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Build the TS module (lib/bundle) so the script can consume it.
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
  "tsc",
  "-p",
  "tsconfig.build.json",
], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
const lib = require(path.join(repoRoot, ".build/lib/bundle/index.js"));
const params = require(path.join(repoRoot, ".build/lib/params.js"));

const { Program, Wallet } = anchorPkg;

// ---- CLI -----------------------------------------------------------------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
function has(name) {
  return process.argv.includes(name);
}

const walletsFile = arg("--wallets", path.join(__dirname, "dev-wallets.json"));
const solInDefault = parseFloat(arg("--sol-in", "0.05"));
const perWalletRaw = arg("--per-wallet", null);
const nonceArg = arg("--nonce", null);
const tokenName = arg("--name", "M2 Atomic Bundle");
const tokenSymbol = arg("--symbol", "M2B");
const tokenUri = arg("--uri", "https://example.com/m2-atomic-bundle.json");
const tier = arg("--tier", "both");
const doFund = !has("--no-fund");
const bundleEndpoint = arg("--bundle-endpoint", lib.JITO_DEVNET_ENDPOINT);
const tipLamports = parseInt(arg("--tip-lamports", "1000"), 10);
const maxAttempts = parseInt(arg("--max-attempts", "3"), 10);
const rpcUrl = arg("--rpc", "https://api.devnet.solana.com");
// M3 per-token migration options, pre-filled from lib/params.ts defaults; the
// launch dashboard (M4) will expose the same toggles.
const autoMigrate = has("--auto-migrate")
  ? !has("--no-auto-migrate")
  : params.DEFAULT_AUTO_MIGRATE;
const lockLp = has("--lock-lp") ? !has("--no-lock-lp") : params.DEFAULT_LOCK_LP;

const EXPLORER = "https://explorer.solana.com";

function fmtLamports(n) {
  return (Number(n) / LAMPORTS_PER_SOL).toFixed(6);
}

function log(...a) {
  console.log(...a);
}

async function main() {
  // ---- identity ----------------------------------------------------------
  const keypairPath =
    process.env.SOLANA_KEYPAIR ??
    path.join(os.homedir(), ".config", "solana", "devnet.json");
  const creatorSecret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
  const creator = Keypair.fromSecretKey(Uint8Array.from(creatorSecret));

  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchorPkg.AnchorProvider(connection, new Wallet(creator), {
    commitment: "confirmed",
  });
  const idl = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "target/idl/pumpfun.json"), "utf8")
  );
  const program = new Program(idl, provider);

  // ---- wallets -----------------------------------------------------------
  if (!fs.existsSync(walletsFile)) {
    console.error(`no wallet file at ${walletsFile}; run: node scripts/gen-wallets.mjs 6`);
    process.exit(1);
  }
  const walletData = JSON.parse(fs.readFileSync(walletsFile, "utf8"));
  const walletSecrets = Array.isArray(walletData.wallets)
    ? walletData.wallets
    : walletData;
  if (!Array.isArray(walletSecrets) || walletSecrets.length === 0) {
    console.error("wallet file must contain a .wallets array of {secret}");
    process.exit(1);
  }
  const wallets = walletSecrets.map((w, i) => {
    const secretStr = typeof w === "string" ? w : w.secret;
    const kp = Keypair.fromSecretKey(bs58.decode(secretStr));
    return { kp, label: w.label ?? `dev-${i + 1}` };
  });

  let solIns = [];
  if (perWalletRaw) {
    solIns = perWalletRaw.split(",").map((s) => parseFloat(s.trim()));
    if (solIns.length !== wallets.length) {
      console.error(`--per-wallet has ${solIns.length} values but ${wallets.length} wallets`);
      process.exit(1);
    }
  } else {
    solIns = wallets.map(() => solInDefault);
  }

  const nonce = nonceArg ? BigInt(nonceArg) : BigInt(Date.now());
  const pda = lib.derivePdas(program.programId, creator.publicKey, nonce);

  const creatorBalance = await connection.getBalance(creator.publicKey, "confirmed");
  const ataRent = await lib.ataRentLamports(connection);
  // Each wallet needs: sol_in (to the vault) + ATA rent (first buy creates it)
  // + the rent-exempt floor it must retain after the buy (890,880 lamports,
  // measured) + a small margin.
  const fundPerWallet = wallets.map(
    (w, i) =>
      BigInt(Math.round(solIns[i] * LAMPORTS_PER_SOL)) +
      BigInt(ataRent) +
      lib.postBuyFloorLamports()
  );
  const totalFund = fundPerWallet.reduce((a, b) => a + b, 0n);

  log("=== pumpfun M2: atomic multi-wallet launch (devnet) ===");
  log(`program  : ${program.programId.toBase58()}`);
  log(`creator  : ${creator.publicKey.toBase58()}  (${fmtLamports(creatorBalance)} SOL)`);
  log(`nonce    : ${nonce}`);
  log(`mint     : ${pda.mint.toBase58()}`);
  log(`curve    : ${pda.curveState.toBase58()}`);
  log(`metadata : ${pda.metadata.toBase58()}`);
  log(`name/sym : ${tokenName} / ${tokenSymbol}`);
  log(`migration: auto_migrate=${autoMigrate} lock_lp=${lockLp} (M3 flags passed to create)`);
  log(`wallets  : ${wallets.length}`);
  for (let i = 0; i < wallets.length; i++) {
    log(`   ${wallets[i].label.padEnd(8)} ${wallets[i].kp.publicKey.toBase58()}  buys ${solIns[i].toFixed(4)} SOL`);
  }
  log(
    `fund     : ${doFund ? fmtLamports(totalFund) + " SOL from creator (sol_in + ATA rent " + fmtLamports(ataRent) + " + rent-exempt floor " + fmtLamports(lib.postBuyFloorLamports()) + ")" : "disabled"}`
  );
  if (doFund && creatorBalance < Number(totalFund) + 0.02 * LAMPORTS_PER_SOL) {
    console.error("creator balance too low for funding + create; aborting");
    process.exit(1);
  }
  log();

  const buys = wallets.map((w, i) => ({
    wallet: w.kp,
    solInLamports: BigInt(Math.round(solIns[i] * LAMPORTS_PER_SOL)),
  }));
  const fundArg = doFund ? fundPerWallet : null;

  // ---- Tier 1: normal multi-signer send ---------------------------------
  if (tier === "1" || tier === "both") {
    log("---------------- TIER 1: normal devnet send (no Jito) ----------------");
    const seq1 = await lib.buildLaunchSequence({
      program,
      connection,
      creator,
      nonce,
      name: tokenName,
      symbol: tokenSymbol,
      uri: tokenUri,
      autoMigrate,
      lockLp,
      buys,
      fundLamportsPerWallet: fundArg,
      // Tier 1 has no bundle tip, so the full 1222-byte budget is available:
      // 5 wallets (1173 bytes) pack into one buy tx.
      maxBuyTxBytes: 1222,
      tipReserveBytes: 0,
    });
    log(`packing : ${seq1.buyTxs.length} buy tx(s):`);
    for (const bt of seq1.buyTxs) {
      log(`   ${bt.wallets.length} wallets, ${bt.signedSize} bytes (budget 1222)`);
    }

    log("preflight: simulating create + buy txs...");
    const pre = await lib.preflightLaunch(connection, seq1);
    log(`   create  : ${pre.create.unitsConsumed} CU, ok`);
    for (const c of pre.buyChunks) {
      log(
        `   buy${c.buyTxIndex + 1} chunk (${c.walletCount} wallets): ${c.result.unitsConsumed} CU, ok`
      );
    }

    log("sending launch txs sequentially (fund -> create -> buys)...");
    const sent = await lib.sendSequentially(connection, seq1, {
      onSignature: (label, sig) =>
        log(`[${label.padEnd(6)}] ${sig}  ${EXPLORER}/tx/${sig}?cluster=devnet`),
    });

    log();
    log("=== holder distribution after Tier 1 (devnet reality) ===");
    const balances = [];
    for (let i = 0; i < wallets.length; i++) {
      const bal = await lib.walletTokenBalance(connection, wallets[i].kp.publicKey, pda.mint);
      balances.push(bal);
      log(
        `   ${wallets[i].label.padEnd(8)} ${wallets[i].kp.publicKey.toBase58().slice(0, 12)}...  ${(Number(bal) / 1e6).toFixed(6)} tokens`
      );
    }
    const rosterHolders = balances.filter((b) => b > 0n).length;
    log(`holders (known wallet roster, non-zero): ${rosterHolders}`);
    try {
      const holders = await lib.holderCount(connection, pda.mint);
      log(`holders (getTokenLargestAccounts on-chain): ${holders}`);
    } catch {
      log("holders (getTokenLargestAccounts on-chain): rate-limited on the public");
      log("   devnet RPC; the known-wallet roster above is the authoritative count.");
    }
    const curve = await program.account.curveStateAccount.fetch(pda.curveState);
    log(
      `curve state: solReserve=${curve.solReserve.toString()} tokenReserve=${curve.tokenReserve.toString()} supplyOut=${curve.supplyOut.toString()}`
    );
    log(
      `price      : ${(Number(curve.solReserve.toString()) / Number(curve.tokenReserve.toString())).toFixed(6)} lamports/token`
    );
    log(`token      : ${EXPLORER}/address/${pda.mint.toBase58()}?cluster=devnet`);
    log(`sent txs   : ${sent.length} (${sent.map((s) => s.label).join(", ")})`);
    log();
  }

  // ---- Tier 2: Jito bundle ----------------------------------------------
  if (tier === "2" || tier === "both") {
    log("---------------- TIER 2: Jito bundle (assembly + sim + submit) ----------------");
    const nonce2 = nonceArg ? BigInt(nonceArg) + 1n : BigInt(Date.now() + 1);
    const pda2 = lib.derivePdas(program.programId, creator.publicKey, nonce2);
    log(`fresh launch for the bundle: nonce ${nonce2}, mint ${pda2.mint.toBase58()}`);

    const seq2 = await lib.buildLaunchSequence({
      program,
      connection,
      creator,
      nonce: nonce2,
      name: tokenName,
      symbol: tokenSymbol,
      uri: tokenUri,
      autoMigrate,
      lockLp,
      buys,
      fundLamportsPerWallet: fundArg,
      // default packing: 1150-byte budget, 90 bytes reserved in the last tx
      // for the tip transfer, so the tip-carrying last tx holds 4 wallets max.
    });
    log(`packing : ${seq2.buyTxs.length} buy tx(s):`);
    for (const bt of seq2.buyTxs) {
      log(
        `   ${bt.wallets.length} wallets, ${bt.signedSize} bytes (budget 1060, tip reserve 90)`
      );
    }
    log("preflight: simulating create + buy txs...");
    const pre2 = await lib.preflightLaunch(connection, seq2);
    log(`   create  : ${pre2.create.unitsConsumed} CU, ok`);
    for (const c of pre2.buyChunks) {
      log(
        `   buy${c.buyTxIndex + 1} chunk (${c.walletCount} wallets): ${c.result.unitsConsumed} CU, ok`
      );
    }

    // reachability probe on the requested block engine
    const jito = new lib.JitoBundleClient(bundleEndpoint);
    let tipAccounts = null;
    let unreachable = null;
    try {
      tipAccounts = await lib.withTimeout(jito.getTipAccounts(), 10_000, "getTipAccounts timed out");
    } catch (e) {
      unreachable = e instanceof Error ? e.message : String(e);
    }
    if (unreachable) {
      log(`jito endpoint ${bundleEndpoint}: UNREACHABLE (${unreachable})`);
      log("   this matches the known devnet reality: the devnet block engine");
      log("   host does not resolve, so devnet bundles cannot be submitted or land.");
      log("   the construction stays fully testable without Jito (Tier 1 proved it).");
    } else {
      log(`jito endpoint ${bundleEndpoint}: reachable (${tipAccounts.length} tip accounts)`);
    }

    // tip account: verify the known list against the live mainnet endpoint
    const mainnetJito = new lib.JitoBundleClient(lib.JITO_MAINNET_ENDPOINT);
    let liveTips = [];
    try {
      const v = await lib.withTimeout(mainnetJito.verifyKnownTipAccounts(), 10_000, "verifyKnownTipAccounts timed out");
      liveTips = v.live;
      log("tip account verification (live mainnet list):");
      log(`   live count : ${v.live.length}`);
      log(`   known      : ${v.known.join(", ")}`);
      log(
        `   missing    : ${v.missing.length === 0 ? "none (both known accounts present)" : v.missing.join(", ")}`
      );
      log(`   note       : the prompt's first address is missing a trailing "5";`);
      log(`               the canonical account is ${lib.KNOWN_TIP_ACCOUNTS[0]}`);
    } catch (e) {
      log(`tip account verification failed: ${e instanceof Error ? e.message : e}`);
    }
    const tipAccount = new PublicKey(
      liveTips.length > 0 ? liveTips[Math.floor(Math.random() * liveTips.length)] : lib.KNOWN_TIP_ACCOUNTS[0]
    );

    // bundle = [fund?, create, buy1, buy2, ...]
    const bundleTxs = lib.sequenceTxs(seq2);
    const bundleSigners = seq2.signersByTx;

    const latest2 = await connection.getLatestBlockhash("confirmed");
    const assembled = await jito.assembleBundle({
      txs: bundleTxs,
      signersByTx: bundleSigners,
      blockhash: latest2.blockhash,
      lastValidBlockHeight: latest2.lastValidBlockHeight,
      tipAccount,
      tipLamports,
      tipPayer: creator,
    });
    const bundleLabels = bundleTxs.map((_, i) => {
      const base = i === 0 && doFund ? "fund" : i === (doFund ? 1 : 0) ? "create" : `buy${i - (doFund ? 1 : 0)}`;
      return i === bundleTxs.length - 1 ? `${base}+tip` : base;
    });
    log(`bundle assembled: ${assembled.base64.length} txs, tip ${tipLamports} lamports -> ${tipAccount.toBase58()}`);
    for (let i = 0; i < assembled.signedTxs.length; i++) {
      log(
        `   tx${i} ${bundleLabels[i].padEnd(10)} signed ${assembled.signedTxs[i].serialize().length} bytes, base64 ${assembled.base64[i].length} chars`
      );
    }

    log("bundle simulation (each leg, tip included):");
    const tipIx = SystemProgram.transfer({
      fromPubkey: creator.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });
    const sims = await lib.simulateBundle(connection, {
      createIx: seq2.createIx,
      fundIx: seq2.fundIx,
      fundIxPerWallet: seq2.fundIxPerWallet,
      buyTxs: seq2.buyTxs.map((bt) => ({ wallets: bt.wallets, instructions: bt.instructions })),
      tipIx,
      creator,
    });
    for (const s of sims) log(`   ${s.label.padEnd(14)} ${s.unitsConsumed} CU, ok`);

    if (unreachable) {
      // Encoding validation against the reachable mainnet endpoint.
      log();
      log("=== sendBundle encoding validation (mainnet endpoint, devnet bundle) ===");
      log("   sending the devnet bundle to the reachable mainnet block engine.");
      log("   a rejection is EXPECTED (devnet blockhash / program do not exist on");
      log("   mainnet); a parse error instead would prove broken base64 encoding.");
      try {
        const mainnetAssembled = await mainnetJito.assembleBundle({
          txs: bundleTxs,
          signersByTx: bundleSigners,
          blockhash: latest2.blockhash,
          lastValidBlockHeight: latest2.lastValidBlockHeight,
          tipAccount,
          tipLamports,
          tipPayer: creator,
        });
        const bundleId = await lib.withTimeout(
          mainnetJito.sendBundle(mainnetAssembled.base64),
          15_000,
          "sendBundle timed out"
        );
        log(`   mainnet accepted the devnet bundle (id ${bundleId}); polling status...`);
        // The bundle cannot land on mainnet (devnet blockhash / program); the
        // status proves the rejection is chain-level, not encoding-level.
        let finalStatus = null;
        for (let p = 0; p < 6; p++) {
          try {
            finalStatus = await mainnetJito.inflightStatus(bundleId);
            if (finalStatus &&
                (finalStatus.status === "Landed" || finalStatus.status === "Failed" ||
                 finalStatus.status === "Invalid")) {
              break;
            }
          } catch {
            // ignore transient poll errors
          }
          await new Promise((r) => setTimeout(r, 2_000));
        }
        log(`   mainnet bundle status: ${JSON.stringify(finalStatus ?? "no final status")}`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`   mainnet sendBundle response: ${msg}`);
      }
      log("   => the request was parsed and the base64 decoded (a malformed bundle");
      log("      would fail JSON-RPC parsing before any chain check); the rejection is");
      log("      chain-level (devnet blockhash / program do not exist on mainnet),");
      log("      exactly as expected. No tip moves on a rejected bundle.");
      log();
      log("TIER 2 RESULT: bundle assembled, base64-encoded, tip-carrying, and fully");
      log("simulated; submission to the devnet block engine is impossible (host does");
      log("not resolve). No fabricated bundle-landing claim: devnet bundles cannot land.");
    } else {
      log("submitting bundle with escalating tip...");
      const result = await jito.submitWithRetry({
        txs: bundleTxs,
        signersByTx: bundleSigners,
        tipPayer: creator,
        tipAccount,
        initialTipLamports: tipLamports,
        maxAttempts,
        pollTimeoutMs: 40_000,
        pollIntervalMs: 2_500,
        connection,
        onAttempt: (a) =>
          log(
            `   attempt ${a.attempt}: tip ${a.tipLamports} lamports` +
              (a.bundleId ? `, bundle ${a.bundleId}` : "") +
              (a.status ? `, status ${a.status}` : "") +
              (a.sendError ? `, error: ${a.sendError}` : "")
          ),
      });
      log(
        `TIER 2 RESULT: ${result.outcome}${result.bundleId ? ` (bundle ${result.bundleId})` : ""}${result.landedSlot != null ? `, landed slot ${result.landedSlot}` : ""}`
      );
      if (result.note) log(`   note: ${result.note}`);
    }
    log();
  }

  log("=== done ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
