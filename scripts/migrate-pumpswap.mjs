// Milestone M3 migration script (client-driven, Option B).
//
// Reads a graduated curve, wraps the released real SOL to WSOL, seeds a
// PumpSwap pool via the official @pump-fun/pump-swap-sdk, and honors the
// per-token lock_lp flag (burn LP when true, leave it under the creator when
// false). Prints the pool address, reserves and LP state after the run.
//
// The migration is OFF-CHAIN: the M3 program only finalizes the curve and
// releases the funds; this script does the PumpSwap seeding. The M4 UI will
// invoke lib/migrate.ts (the same logic) after graduation.
//
// Usage:
//   node scripts/migrate-pumpswap.mjs --mint <TOKEN_MINT> [opts]
// Options:
//   --mint <addr>        the graduated token mint (base mint of the pool)
//   --rpc <url>          RPC (default localnet http://127.0.0.1:8899)
//   --keypair <path>     creator keypair (default $SOLANA_KEYPAIR /
//                        ~/.config/solana/devnet.json)
//   --id <program-id>    launchpad program id (default from target/idl)
//   --sol <n>            real SOL to seed (default: effective raised
//                        approximation, curve.solReserve - 30 virtual SOL;
//                        pass the exact released amount when known)
//   --index <n>          PumpSwap pool index seed (default 0)
//   --lock-lp / --no-lock-lp   override the per-token lock_lp flag
//   --dry-run            print the plan without sending

import anchorPkg from "@coral-xyz/anchor";
import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");

// Build the TS module (lib/migrate) so the script can consume it.
execFileSync(process.platform === "win32" ? "npx.cmd" : "npx", [
  "tsc",
  "-p",
  "tsconfig.build.json",
], { cwd: repoRoot, stdio: ["ignore", "ignore", "inherit"] });
const migrate = require(path.join(repoRoot, ".build/lib/migrate.js"));

const { Wallet } = anchorPkg;

function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i === -1 ? def : process.argv[i + 1];
}
function has(name) {
  return process.argv.includes(name);
}

const rpcUrl = arg("--rpc", "http://127.0.0.1:8899");
const mintArg = arg("--mint", null);
const keypairPath =
  arg("--keypair", null) ??
  process.env.SOLANA_KEYPAIR ??
  path.join(os.homedir(), ".config", "solana", "devnet.json");
const solArg = arg("--sol", null);
const index = parseInt(arg("--index", "0"), 10);
const dryRun = has("--dry-run");
const lockLpOverride = has("--lock-lp")
  ? true
  : has("--no-lock-lp")
  ? false
  : null;

function fmtSol(l) {
  return (Number(l) / LAMPORTS_PER_SOL).toFixed(6);
}

async function main() {
  if (!mintArg) {
    console.error("usage: node scripts/migrate-pumpswap.mjs --mint <TOKEN_MINT> [opts]");
    process.exit(1);
  }
  const mint = new PublicKey(mintArg);
  const creator = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(keypairPath, "utf8")))
  );
  const connection = new Connection(rpcUrl, "confirmed");
  const provider = new anchorPkg.AnchorProvider(
    connection,
    new Wallet(creator),
    { commitment: "confirmed" }
  );
  const idl = JSON.parse(
    fs.readFileSync(path.join(repoRoot, "target/idl/pumpfun.json"), "utf8")
  );
  const program = new anchorPkg.Program(idl, provider);

  console.log("=== pumpfun M3: client-driven PumpSwap migration ===");
  console.log(`mint      : ${mint.toBase58()}`);
  console.log(`creator   : ${creator.publicKey.toBase58()}`);
  console.log(`rpc       : ${rpcUrl}`);
  console.log(`index     : ${index}`);

  const curveKey = migrate.curveStatePda(program.programId, mint);
  const curve = await program.account.curveStateAccount.fetch(curveKey);
  console.log(`curve     : ${curveKey.toBase58()}`);
  console.log(`graduated : ${curve.graduated}`);
  if (!curve.graduated) {
    console.error("curve is not graduated; nothing to migrate (buy/sell still open)");
    process.exit(1);
  }

  const baseAmount = migrate.remainingSupply(curve);
  const defaultQuote = migrate.realSolLamports(curve);
  const quoteAmount = solArg !== null
    ? BigInt(Math.round(parseFloat(solArg) * LAMPORTS_PER_SOL))
    : defaultQuote;
  const lockLp = lockLpOverride !== null ? lockLpOverride : curve.lockLp;

  console.log(`base      : ${baseAmount} raw tokens (remaining supply)`);
  console.log(`quote     : ${fmtSol(quoteAmount)} SOL (released real SOL)`);
  if (solArg === null) {
    console.log(`            (default approximation = curve.solReserve - 30 virtual SOL;`);
    console.log(`             pass --sol <n> for the exact released amount)`);
  }
  console.log(`lock_lp   : ${lockLp} (from ${lockLpOverride !== null ? "CLI override" : "curve state"})`);

  if (dryRun) {
    console.log("dry-run: no transaction sent.");
    return;
  }

  const result = await migrate.migrateToPumpSwap({
    connection,
    creator,
    program,
    mint,
    index,
    quoteLamports: quoteAmount,
    lockLp,
  });

  console.log();
  console.log("=== PumpSwap pool after migration ===");
  console.log(`pool      : ${result.poolKey.toBase58()}`);
  console.log(`lp mint   : ${result.lpMint.toBase58()}`);
  console.log(`base ATA  : ${result.poolBaseTokenAccount.toBase58()}`);
  console.log(`quote ATA : ${result.poolQuoteTokenAccount.toBase58()}`);
  console.log(`reserves  : ${result.baseAmount} base / ${fmtSol(result.quoteAmount)} quote (WSOL)`);
  console.log(`lpSupply  : ${result.lpSupply.toString()}`);
  console.log(`creator LP: ${result.creatorLpBalance.toString()} (${result.lpLocked ? "locked: burned" : "unlocked: under creator"})`);
  console.log(`LP locked : ${result.lpLocked}`);
  console.log("=== done ===");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
