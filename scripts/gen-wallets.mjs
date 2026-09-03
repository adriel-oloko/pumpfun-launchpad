// Generates throwaway devnet test wallets into scripts/dev-wallets.json.
// These are devnet-only rehearsal keys (base58 64-byte secrets), never used on
// mainnet. The launch script funds them from the devnet creator wallet.
//
// Usage: node scripts/gen-wallets.mjs [count] [sol-in-per-wallet]
//   count: number of wallets (default 6)
//   sol-in: SOL each wallet buys at launch (default 0.05)

import { Keypair } from "@solana/web3.js";
import bs58 from "bs58";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const count = parseInt(process.argv[2] ?? "6", 10);
const solIn = parseFloat(process.argv[3] ?? "0.05");

if (!Number.isFinite(count) || count < 1) {
  console.error("count must be a positive integer");
  process.exit(1);
}

const wallets = [];
for (let i = 1; i <= count; i++) {
  const kp = Keypair.generate();
  wallets.push({
    label: `dev-${String(i).padStart(2, "0")}`,
    pubkey: kp.publicKey.toBase58(),
    secret: bs58.encode(kp.secretKey),
  });
}

const outPath = path.join(__dirname, "dev-wallets.json");
const payload = {
  generatedAt: new Date().toISOString(),
  network: "devnet",
  solIn,
  wallets,
};
fs.writeFileSync(outPath, JSON.stringify(payload, null, 2) + "\n");
console.log(`wrote ${count} devnet wallets to ${outPath} (sol-in ${solIn} SOL each)`);
for (const w of wallets) {
  console.log(`  ${w.label}: ${w.pubkey}`);
}
