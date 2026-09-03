// Managed wallet roster for the launch panel's "launch with dev wallets"
// feature. Ported from v4-launchpad lib/v4-managed-wallets.ts with ONE
// deliberate change: the key format. v4 persisted 32-byte hex EVM keys; this
// app persists Solana keypairs, a 64-byte secret key encoded as base58
// (88 chars), with the 44-char pubkey derived via
// Keypair.fromSecretKey(bs58.decode(key)).
//
// Addresses AND private keys are persisted to localStorage, mirroring the
// v4 managed-wallet roster: each key survives reloads for a rolling
// 1440-hour (60-day) window that starts from the moment the key is
// (re-)entered. Expired keys are dropped on load/persist while the address
// stays in the roster as watch-only, so it can be re-keyed without losing
// the entry.
//
// IMPORTANT: Solana base58 addresses are CASE-SENSITIVE. The v4 lowercasing
// rule is for EVM hex, NOT Solana. Do NOT lowercase any address or pubkey
// anywhere in this module; a lowercased base58 pubkey is a different
// (invalid) address and would silently desync the roster from the chain.

import bs58 from "bs58";
import { Keypair, PublicKey } from "@solana/web3.js";

const STORAGE_KEY = "pumpfun.managedWallets.v1";
/** How long a managed-wallet key survives a reload: 1440 hours (60 days). */
const SESSION_TTL_MS = 1440 * 60 * 60 * 1000;

export interface ManagedWallet {
  /** Solana pubkey, base58 (44 chars), case-sensitive. */
  address: string;
  /** Secret key, base58-encoded 64 bytes (88 chars), persisted with a
   *  rolling 1440-hour expiry. */
  key?: string;
  /** Epoch ms at which the key expires; refreshed whenever the key is
   *  re-entered. */
  keyExpiresAt?: number;
}

/** Epoch ms at which a key entered right now expires (now + 1440 hours). */
export function freshKeyExpiry(): number {
  return Date.now() + SESSION_TTL_MS;
}

/** Whole days left on a wallet's key (clamped to >= 1); the full 60 when
 *  unset. */
export function keyDaysLeft(wallet: ManagedWallet): number {
  if (!wallet.keyExpiresAt) return Math.floor(SESSION_TTL_MS / 86_400_000);
  return Math.max(1, Math.ceil((wallet.keyExpiresAt - Date.now()) / 86_400_000));
}

/** True when the string decodes as a 64-byte Solana secret key. */
export function isSolanaSecretKey(key: string): boolean {
  try {
    return bs58.decode(key).length === 64;
  } catch {
    return false;
  }
}

/** Derives the base58 pubkey from a base58 64-byte secret, or null when the
 *  key is malformed. Uses Keypair.fromSecretKey so the result is the exact
 *  on-chain address. */
export function pubkeyFromSecretKey(key: string): string | null {
  try {
    return Keypair.fromSecretKey(bs58.decode(key)).publicKey.toBase58();
  } catch {
    return null;
  }
}

/** True when the string parses as a Solana pubkey (base58, on-curve check
 *  deferred to the caller's chain reads; PublicKey ctor validates format). */
export function isValidPubkey(address: string): boolean {
  try {
    new PublicKey(address);
    return true;
  } catch {
    return false;
  }
}

/** Parses a free-form paste of one or more base58 secret keys (whitespace,
 *  comma, or newline separated). Returns the derived pubkey per key so the
 *  caller can dedupe by exact base58 address. */
export function parseSecretKeys(raw: string): { address: string; key: string }[] {
  const parts = raw
    .split(/[\s,;\n]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: { address: string; key: string }[] = [];
  for (const part of parts) {
    if (!isSolanaSecretKey(part)) continue;
    const address = pubkeyFromSecretKey(part);
    if (!address) continue;
    out.push({ address, key: part });
  }
  return out;
}

/** Read the persisted roster. Expired keys are dropped; addresses are kept. */
export function loadManagedWallets(): ManagedWallet[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const wallets: ManagedWallet[] = [];
    for (const entry of parsed) {
      if (!entry || typeof entry !== "object") continue;
      const { address, key, keyExpiresAt } = entry as {
        address?: unknown;
        key?: unknown;
        keyExpiresAt?: unknown;
      };
      if (typeof address !== "string" || !isValidPubkey(address)) continue;
      const wallet: ManagedWallet = { address };
      if (
        typeof key === "string" &&
        typeof keyExpiresAt === "number" &&
        keyExpiresAt > Date.now() &&
        isSolanaSecretKey(key) &&
        // The stored key must derive the stored address (case-sensitive);
        // a mismatch means the entry is corrupt, drop the key not the row.
        pubkeyFromSecretKey(key) === address
      ) {
        wallet.key = key;
        wallet.keyExpiresAt = keyExpiresAt;
      }
      // Expired / malformed key: keep the address, drop the key.
      wallets.push(wallet);
    }
    return wallets;
  } catch {
    return [];
  }
}

/** Persist the roster. Keys are stored with their rolling 1440h expiry. */
export function persistManagedWallets(wallets: ManagedWallet[]): void {
  if (typeof window === "undefined") return;
  try {
    const now = Date.now();
    const clean = wallets.map((w) => {
      if (!w.key) return { address: w.address };
      const expiresAt =
        typeof w.keyExpiresAt === "number" && w.keyExpiresAt > now
          ? w.keyExpiresAt
          : now + SESSION_TTL_MS; // key set without a valid window -> fresh 1440h
      return { address: w.address, key: w.key, keyExpiresAt: expiresAt };
    });
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(clean));
  } catch {
    // Storage unavailable (private mode / quota): roster stays in memory.
  }
}

/** The persistent storage key, exported for the launch panel's creator-key
 *  field and any future tooling that needs to inspect the roster. */
export const MANAGED_WALLETS_STORAGE_KEY = STORAGE_KEY;
