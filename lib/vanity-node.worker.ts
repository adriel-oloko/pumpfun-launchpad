// Node worker_threads entry for the parallel vanity "pump" mint grind —
// NODE ONLY (mirror of the browser lib/vanity.worker.ts, but for
// `worker_threads` instead of Web Workers).
//
// BUILD-CONTEXT CONTRACT: this file is compiled to CommonJS by
// tsconfig.build.json into .build/lib/vanity-node.worker.js and is spawned
// from lib/vanity-node.ts via `new Worker(path.join(__dirname,
// 'vanity-node.worker.js'), { workerData: { suffix } })`. It must NEVER be
// imported by lib/bundle/** or by any 'use client' / browser module — it uses
// node:worker_threads and only ever runs inside a Node worker thread.
//
// Each worker runs the SAME libsodium grind loop as lib/vanity.ts (its own
// fresh random seed, then in-place increments — see the SPEED note there; a
// per-attempt randombytes draw would halve throughput) and posts to the
// parent via parentPort:
//   { type: 'progress', attempts }       every ~250ms, attempts = keypairs
//                                        tested SINCE the last post (deltas;
//                                        the parent sums across workers)
//   { type: 'found',    secretKey }      on a match — a 64-byte Uint8Array
//                                        (seed || publicKey), the exact layout
//                                        Keypair.fromSecretKey round-trips.
//                                        Copied out of the libsodium asm.js
//                                        heap before posting (the next sodium
//                                        call would clobber the view); the
//                                        structured clone then hands the parent
//                                        its own independent copy.
//   { type: 'error',    message }        on a fatal failure
import { parentPort, workerData } from "node:worker_threads";
import sodium from "libsodium-wrappers";
import { pubkeyTailMatches } from "./vanity-match";

interface GrindWorkerData {
  suffix: string;
}

interface ProgressMessage {
  type: "progress";
  attempts: number;
}

interface FoundMessage {
  type: "found";
  secretKey: Uint8Array;
}

interface ErrorMessage {
  type: "error";
  message: string;
}

type WorkerMessage = ProgressMessage | FoundMessage | ErrorMessage;

const port = parentPort;
if (!port) {
  throw new Error("vanity-node.worker must run inside a worker_threads Worker");
}

const suffix = (workerData as GrindWorkerData | undefined)?.suffix ?? "pump";

/** In-place big-endian +1 on a 32-byte seed (see lib/vanity.ts). */
function incrementSeed(seed: Uint8Array): void {
  for (let i = seed.length - 1; i >= 0; i -= 1) {
    seed[i] = (seed[i] + 1) & 0xff;
    if (seed[i] !== 0) return;
  }
}

void (async (): Promise<void> => {
  try {
    await sodium.ready;
    // One RNG draw per worker; every subsequent attempt increments this seed
    // in place. crypto_sign_seed_keypair reads it synchronously, so mutating
    // it right after each call is safe.
    const seed = sodium.randombytes_buf(32);
    let attempts = 0;
    let lastPostedAttempts = 0;
    let lastProgressAt = 0;
    for (;;) {
      incrementSeed(seed);
      const candidate = sodium.crypto_sign_seed_keypair(seed);
      attempts += 1;
      if (pubkeyTailMatches(candidate.publicKey, suffix)) {
        // Copy out of the libsodium asm.js heap before posting: the returned
        // views alias heap memory the next call can clobber.
        const message: FoundMessage = {
          type: "found",
          secretKey: Uint8Array.from(candidate.privateKey),
        };
        port.postMessage(message);
        return;
      }
      const now = Date.now();
      if (now - lastProgressAt >= 250) {
        const message: ProgressMessage = {
          type: "progress",
          // Delta since the last post: the parent sums per-worker deltas.
          attempts: attempts - lastPostedAttempts,
        };
        port.postMessage(message);
        lastProgressAt = now;
        lastPostedAttempts = attempts;
      }
    }
  } catch (error) {
    const message: ErrorMessage = {
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    port.postMessage(message);
  }
})();
