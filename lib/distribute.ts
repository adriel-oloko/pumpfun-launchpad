// Roster key-management helpers for the Distribute feature set (M8B):
// in-app random keypair generation plus an automatic PK backup download.
// Pure module: no UI. The backup half mirrors v4-launchpad's
// exportPksBackup (trade-panel.tsx lines ~198-230): a timestamped pk.json
// whose payload is an ARRAY OF SECRET KEY STRINGS ONLY (base58, no
// addresses, no expiry), covering every KEYED wallet in the roster.
//
// IMPORTANT: Solana addresses AND secret keys are case-sensitive base58.
// Never lowercase anything here. Keys come from Keypair.generate() (which
// uses crypto.getRandomValues internally), never Math.random.

import bs58 from "bs58";
import { Keypair } from "@solana/web3.js";
import { freshKeyExpiry, type ManagedWallet } from "./managed-wallets";

/** Mint `count` fresh Solana keypairs as managed wallets (clamped to
 *  [1, 1000] per call). Each key is the base58-encoded 64-byte secret with
 *  the same 1440h persistence window as pasted keys. */
export function generateRandomWallets(count: number): ManagedWallet[] {
  const n = Math.min(1000, Math.max(1, Math.floor(count) || 1));
  const out: ManagedWallet[] = [];
  for (let i = 0; i < n; i++) {
    const kp = Keypair.generate();
    out.push({
      address: kp.publicKey.toBase58(),
      key: bs58.encode(kp.secretKey),
      keyExpiresAt: freshKeyExpiry(),
    });
  }
  return out;
}

/** Timestamped backup filename for wallet private keys, e.g.
 *  2026-9-3-14-5pk.json (local time, NO zero padding). The user's
 *  "2026/9/3/14/5" spec uses slashes, which are invalid in filenames (and
 *  the download attribute strips them), so dashes stand in. */
export function pksBackupName(now: Date): string {
  return `${now.getFullYear()}-${now.getMonth() + 1}-${now.getDate()}-${now.getHours()}-${now.getMinutes()}pk.json`;
}

/** Download every KEYED wallet's secret key as a JSON backup file (browser
 *  download via Blob + anchor): key strings ONLY, no addresses, no expiry
 *  metadata. Watch-only (keyless) roster entries are skipped, nothing to
 *  export for them. Returns the filename, or null when no wallet holds a
 *  key. Browser-only; the roster calls it exclusively from click handlers. */
export function exportPksBackup(wallets: ManagedWallet[]): string | null {
  const keyed = wallets.filter(
    (w): w is ManagedWallet & { key: string } => Boolean(w.key)
  );
  if (keyed.length === 0) return null;
  const filename = pksBackupName(new Date());
  const payload = keyed.map((w) => w.key);
  const blob = new Blob([JSON.stringify(payload, null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
  return filename;
}
