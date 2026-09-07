// Web Worker entry for the vanity "pump" mint grind — BROWSER ONLY.
//
// Bundled by Next.js/Turbopack via the `new Worker(new URL('./vanity.worker.ts',
// import.meta.url), { type: 'module' })` pattern in lib/vanity-client.ts. This
// file is never imported by lib/bundle/** (not in tsconfig.build.json's
// include, no import.meta constraint here) and never imported by any server
// component — it only ever runs inside a dedicated browser thread.
//
// Each worker runs an independent libsodium grind loop (its own fresh random
// seed, then in-place increments — see the SPEED note in lib/vanity.ts; a
// per-attempt randombytes draw would halve throughput) and posts:
//   { type: 'progress', attempts }                       every ~250ms, where
//                                                        attempts = keypairs
//                                                        tested SINCE the last
//                                                        progress post (deltas;
//                                                        the main thread sums
//                                                        them across workers)
//   { type: 'found',    pubkey, secretKey: ArrayBuffer } on a match
//   { type: 'error',    message }                        on a fatal failure
//
// The 64-byte secretKey is (seed || publicKey) — the exact layout
// Keypair.fromSecretKey round-trips — and is transferred to the main thread
// (zero-copy) where lib/vanity-client.ts wraps it in a @solana/web3.js
// Keypair. The secret key never leaves the page and is never logged.
import sodium from "libsodium-wrappers";
import bs58 from "bs58";
import { pubkeyTailMatches } from "./vanity-match";

interface StartMessage {
  type: "start";
  suffix: string;
}

let started = false;

self.onmessage = (event: MessageEvent<StartMessage>): void => {
  const message = event.data;
  if (message?.type !== "start" || started) return;
  started = true;
  void grind(message.suffix);
};

/** In-place big-endian +1 on a 32-byte seed (see lib/vanity.ts). */
function incrementSeed(seed: Uint8Array): void {
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    seed[i] = (seed[i] + 1) & 0xff;
    if (seed[i] !== 0) return;
  }
}

async function grind(suffix: string): Promise<void> {
  try {
    await sodium.ready;
    const seed = sodium.randombytes_buf(32);
    let attempts = 0;
    let lastPostedAttempts = 0;
    let lastProgressAt = 0;
    for (;;) {
      incrementSeed(seed);
      const candidate = sodium.crypto_sign_seed_keypair(seed);
      attempts += 1;
      if (pubkeyTailMatches(candidate.publicKey, suffix)) {
        // Copy out of the libsodium heap before transferring.
        const secretKey = new Uint8Array(candidate.privateKey);
        postMessage(
          {
            type: "found",
            // Full encode only ONCE per worker (on the winner); the hot loop
            // uses the pure arithmetic pubkeyTailMatches instead.
            pubkey: bs58.encode(candidate.publicKey),
            secretKey: secretKey.buffer as ArrayBuffer,
          },
          // Zero-copy: the main thread becomes the sole owner of the buffer.
          { transfer: [secretKey.buffer] }
        );
        return;
      }
      const now = Date.now();
      if (now - lastProgressAt >= 250) {
        postMessage({
          type: "progress",
          // Delta since the last post: the main thread sums per-worker deltas
          // into a combined attempt count.
          attempts: attempts - lastPostedAttempts,
        });
        lastProgressAt = now;
        lastPostedAttempts = attempts;
      }
    }
  } catch (error) {
    postMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}
