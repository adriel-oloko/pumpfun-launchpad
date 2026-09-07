// Vanity "pump" mint grinding, single-threaded core (CJS-safe).
//
// Real pump.fun tokens have base58 mint ADDRESSES that end in the literal
// string "pump" (grinded client-side by pump.fun itself). Cosmetic only:
// zero on-chain effect, and the ticker's `.pump` SUFFIX is indexer-applied —
// nothing here ever touches name/symbol/uri.
//
// This module is the shared core used by:
//   - lib/bundle/launch.ts + lib/bundle/single-tx.ts (the default mint path),
//     which compile to CommonJS via `tsc -p tsconfig.build.json` and run
//     inside Node CLI scripts, so this file MUST stay import.meta-free and
//     free of top-level browser globals (no `new Worker(new URL(...))` here —
//     that lives in the browser-only lib/vanity-client.ts, imported only from
//     'use client' components).
//   - lib/vanity-client.ts as the no-Web-Worker fallback.
//
// SPEED (measured on this box, libsodium 0.7.15 asm.js build):
//   - @solana/web3.js Keypair.generate() (noble): ~3,300 keypairs/s.
//   - libsodium crypto_sign_seed_keypair: ~19,000 keypairs/s when the seed
//     comes from an in-place incremented counter (one randombytes_buf draw
//     per grind run). Drawing fresh randombytes_buf(32) EVERY attempt costs
//     ~12k/s of throughput (the wrapper's RNG call dominates), so the loop
//     below increments instead — still cryptographically fine: each grind
//     run (and each Web Worker) starts from its own fresh 32-byte random
//     seed, and each mint keypair signs one create tx then dies.
// "pump" needs 58^4 ≈ 11.3M attempts on average: ~10 min single-threaded,
// and the browser path parallelizes across up to 8 Web Workers
// (lib/vanity-client.ts) to ~1-2 min.
//
// SECURITY: the grinded mint keypair is a real ed25519 secret. It signs the
// pump.fun create tx exactly once (create_account CPI) and is then dead, but
// it must never be logged, persisted, or sent anywhere. Only the derived
// PublicKey (base58 address) may be surfaced.
//
// NOTE: the ambient typings for "libsodium-wrappers" live in
// lib/libsodium-wrappers.d.ts, which tsconfig.build.json lists in its include
// (so the CommonJS program sees them too) and tsconfig.json picks up via its
// **/*.ts glob.
import sodium from "libsodium-wrappers";
import { Keypair } from "@solana/web3.js";
import {
  BASE58_ALPHABET,
  isValidVanitySuffix,
  pubkeyTailMatches,
} from "./vanity-match";

/** Default vanity suffix: the base58 mint ADDRESS must end in "pump". */
export const DEFAULT_VANITY_SUFFIX = "pump";

/** Re-exported for callers/tests that validate a suffix without grinding. */
export { isValidVanitySuffix, pubkeyTailMatches } from "./vanity-match";

/** Throttle between onProgress callbacks (ms). */
const PROGRESS_INTERVAL_MS = 250;

/** Yield to the event loop every N attempts so a single-threaded grind
 *  (Node scripts / no-Worker browsers) never freezes its host (~every 110ms
 *  at 19k/s). */
const YIELD_EVERY_ATTEMPTS = 2048;

/** In-place big-endian +1 on a 32-byte seed. Carries are rare (1/256 per
 *  byte); wrapping the full 2^256 space is unreachable in practice. */
function incrementSeed(seed: Uint8Array): void {
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    seed[i] = (seed[i] + 1) & 0xff;
    if (seed[i] !== 0) return;
  }
}

export interface VanityGrindProgress {
  /** Total candidate keypairs tested so far. */
  attempts: number;
  /** Running average attempts/second (over the whole grind). */
  attemptsPerSecond: number;
}

export interface VanityGrindOptions {
  /** Base58 suffix the mint pubkey must end with (default "pump"). */
  suffix?: string;
  /** Throttled progress callback (fires at most every ~250ms). */
  onProgress?: (progress: VanityGrindProgress) => void;
  /** Abort the grind (checked per attempt + after every event-loop yield). */
  signal?: AbortSignal;
}

/** Error thrown when a grind is aborted via its AbortSignal. */
export function vanityAbortError(): Error {
  const err = new Error("vanity mint grind aborted");
  err.name = "AbortError";
  return err;
}

/** Single-threaded libsodium grind: returns a fresh ed25519 Keypair whose
 *  base58 public key ends in `suffix`. The 64-byte libsodium private key
 *  (seed || publicKey) round-trips through Keypair.fromSecretKey, so the
 *  returned Keypair is a normal @solana/web3.js signer for the create tx.
 *
 *  No import.meta, no browser globals, no Worker: safe to compile to
 *  CommonJS for the Node CLI scripts (tsconfig.build.json) and safe to run
 *  as the browser fallback. Parallel callers (Web Workers) each run their
 *  own copy of this loop and post the winner back — see lib/vanity-client.ts
 *  and lib/vanity.worker.ts. */
export async function grindVanityMintKeypair(
  opts: VanityGrindOptions = {}
): Promise<Keypair> {
  const suffix = opts.suffix ?? DEFAULT_VANITY_SUFFIX;
  if (!isValidVanitySuffix(suffix)) {
    throw new Error(
      `vanity suffix "${suffix}" is not grind-able: only 1-7 case-sensitive chars from the ${BASE58_ALPHABET.length}-char base58 alphabet are allowed`
    );
  }
  const { onProgress, signal } = opts;
  if (signal?.aborted) throw vanityAbortError();

  await sodium.ready;

  // One RNG draw per grind run; every subsequent attempt increments this
  // seed in place (see SPEED note above). Passed by reference to
  // crypto_sign_seed_keypair, which reads it synchronously, so mutating it
  // right after each call is safe.
  const seed = sodium.randombytes_buf(32);

  const startedAt = Date.now();
  let attempts = 0;
  let lastProgressAt = 0;
  const reportProgress = (): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    onProgress({
      attempts,
      attemptsPerSecond: Math.round(
        (attempts * 1000) / Math.max(1, now - startedAt)
      ),
    });
  };

  for (;;) {
    if (signal?.aborted) throw vanityAbortError();

    incrementSeed(seed);
    const candidate = sodium.crypto_sign_seed_keypair(seed);
    attempts += 1;

    if (pubkeyTailMatches(candidate.publicKey, suffix)) {
      // Copy out of the libsodium heap before wrapping: the returned
      // Uint8Arrays are views into asm.js memory that the next call can
      // clobber, and Keypair.fromSecretKey must own a stable buffer.
      const secretKey = Uint8Array.from(candidate.privateKey);
      if (onProgress) {
        onProgress({
          attempts,
          attemptsPerSecond: Math.round(
            (attempts * 1000) / Math.max(1, Date.now() - startedAt)
          ),
        });
      }
      return Keypair.fromSecretKey(secretKey);
    }

    // Yield every ~2048 attempts (~every 110ms at 19k/s): lets the event
    // loop breathe (UI updates, abort events, other work) and bounds the
    // onProgress cadence without per-attempt overhead.
    if ((attempts & (YIELD_EVERY_ATTEMPTS - 1)) === 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      reportProgress();
    }
  }
}
