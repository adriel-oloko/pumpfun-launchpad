// Prints a Solana keypair file (JSON array of 64 bytes, the `solana-keygen`
// format) as the base58 secret key + derived pubkey, ready to paste into the
// launch panel's creator-key field.
//
// Usage:
//   node scripts/keypair-base58.mjs [keypairPath]
// Default keypair path: ~/.config/solana/devnet.json (the project devnet
// deploy wallet).
//
// The 88-char base58 string IS the secret key. It is displayed on your own
// terminal only; treat it like a password. Devnet keys hold faucet SOL only.

import bs58 from "bs58";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Keypair } from "@solana/web3.js";

const keypairPath =
  process.argv[2] ?? path.join(os.homedir(), ".config", "solana", "devnet.json");

if (!fs.existsSync(keypairPath)) {
  console.error(`no keypair at ${keypairPath}`);
  process.exit(1);
}

const secret = JSON.parse(fs.readFileSync(keypairPath, "utf8"));
if (!Array.isArray(secret) || secret.length !== 64) {
  console.error("keypair file must be a JSON array of 64 bytes");
  process.exit(1);
}

const kp = Keypair.fromSecretKey(Uint8Array.from(secret));
console.log(`pubkey  : ${kp.publicKey.toBase58()}`);
console.log(`secret  : ${bs58.encode(Buffer.from(secret))}`);
console.log("paste the secret above into the launch panel CREATOR KEY field.");
