// Node-only PARALLEL vanity "pump" mint grinder — worker_threads pool over
// every core, for the Node CLI launch scripts.
//
// BUILD-CONTEXT CONTRACT (critical): this module imports node:worker_threads
// + node:os + node:path, so it is NODE-ONLY. It is compiled to CommonJS by
// tsconfig.build.json (it IS listed in that config's include) into
// .build/lib/vanity-node.js and required from scripts/*.mjs. It must NEVER
// be imported by lib/bundle/**, by lib/vanity-client.ts (browser worker
// pool), or by any component — nothing in the Next.js bundle may reach it.
// The main tsconfig.json program type-checks it fine (@types/node is a
// devDependency), but it is never part of the browser bundle.
//
// WHY: the single-threaded CJS-safe core (lib/vanity.ts) measures ~19,000
// keypairs/s, so the default "pump" suffix (58^4 ≈ 11.3M expected attempts)
// takes ~10 min in a Node CLI script. Spawning one worker_threads Worker per
// (physical) core — each running the same libsodium grind loop on its own
// fresh random seed — aggregates the grind several-fold and cuts "pump" to
// well under a minute on a many-core box. MEASURED on this dev box (8 cores
// / 16 threads, i9-11900H, asm.js): ~12k keypairs/s per worker and ~50k/s
// aggregate at 4-8 workers — hyperthreading gives asm.js no extra throughput
// and all-core load drops per-core clocks, so 16 workers (~46k/s) grinds
// SLOWER than 8 (~49k/s); the default worker count is therefore the PHYSICAL
// core count, not availableParallelism()'s logical count.
// libsodium-wrappers 0.7.15 is asm.js only, so each worker runs its own
// independent asm.js heap — no shared-memory concerns; workers post progress
// deltas and the winning 64-byte secret key (copied out of the heap) via
// structured clone.
//
// SECURITY: the grinded mint keypair is a real ed25519 secret. It signs the
// pump.fun create tx exactly once and is then dead, but it must never be
// logged, persisted, or sent anywhere. Only the derived PublicKey (base58
// address) may be surfaced.
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { Worker } from "node:worker_threads";
import { Keypair } from "@solana/web3.js";
import {
  DEFAULT_VANITY_SUFFIX,
  grindVanityMintKeypair as grindVanityMintKeypairSingleThread,
  isValidVanitySuffix,
  vanityAbortError,
} from "./vanity";
import type { VanityGrindOptions, VanityGrindProgress } from "./vanity";
import { BASE58_ALPHABET } from "./vanity-match";

/** Re-exported so Node callers share one progress type across paths. */
export type { VanityGrindProgress } from "./vanity";

export interface VanityNodeGrindOptions extends VanityGrindOptions {
  /** Cap on concurrent worker_threads Workers (default: the PHYSICAL core
   *  count — 8 on an 8-core/16-thread box, 16 on a 16-core box — bounded by
   *  os.availableParallelism(); see the MEASURED note above for why physical
   *  cores beat logical ones for this asm.js workload). */
  workers?: number;
}

interface WorkerProgressMessage {
  type: "progress";
  attempts: number;
}

interface WorkerFoundMessage {
  type: "found";
  secretKey: Uint8Array;
}

interface WorkerErrorMessage {
  type: "error";
  message: string;
}

type NodeWorkerMessage =
  | WorkerProgressMessage
  | WorkerFoundMessage
  | WorkerErrorMessage;

/** Parallel libsodium vanity grind across worker_threads Workers (one per
 *  core by default). Resolves with a fresh ed25519 Keypair whose base58
 *  public key ends in `suffix` (default "pump"), or rejects with an
 *  AbortError when `signal` aborts (all workers are terminated). If
 *  worker_threads is unavailable or every worker dies, falls back to the
 *  single-threaded CJS-safe core (lib/vanity.ts) so Node CLI launches never
 *  hard-fail on the vanity path. */
export async function grindVanityMintKeypairParallel(
  opts: VanityNodeGrindOptions = {}
): Promise<Keypair> {
  const suffix = opts.suffix ?? DEFAULT_VANITY_SUFFIX;
  if (!isValidVanitySuffix(suffix)) {
    throw new Error(
      `vanity suffix "${suffix}" is not grind-able: only 1-7 case-sensitive chars from the ${BASE58_ALPHABET.length}-char base58 alphabet are allowed`
    );
  }
  const { onProgress, signal } = opts;
  if (signal?.aborted) throw vanityAbortError();

  // Compiled sibling in .build/lib (this module is CJS there; __dirname
  // points at .build/lib). Never import.meta — CJS output forbids it.
  const workerFile = path.join(__dirname, "vanity-node.worker.js");

  // Worker count: default to PHYSICAL cores when detectable (/proc/cpuinfo),
  // else os.availableParallelism() (logical). On hyperthreaded laptops
  // (e.g. 8 cores / 16 threads) 16 asm.js grind workers contend for the same
  // 8 execution pipes AND drop per-core clocks (power/thermal), so 8 workers
  // measurably out-grinds 16; on a true 16-core box physical == logical and
  // the count is identical. Always capped by availableParallelism (cgroup /
  // WSL quotas) and floor 1. Callers can override with `workers`.
  let physicalCores = 0;
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const match = /^cpu cores\s*:\s*(\d+)/m.exec(cpuinfo);
    if (match) physicalCores = parseInt(match[1], 10);
  } catch {
    // Non-Linux or unreadable: fall through to availableParallelism().
  }
  let available: number;
  try {
    available =
      typeof os.availableParallelism === "function"
        ? os.availableParallelism()
        : os.cpus().length;
  } catch {
    available = os.cpus().length;
  }
  const defaultWorkers =
    physicalCores > 0 ? Math.min(physicalCores, available) : available;
  const workerCount = Math.max(1, Math.min(opts.workers ?? defaultWorkers, available));

  return new Promise<Keypair>((resolve, reject) => {
    const workers: Worker[] = [];
    let settled = false;
    let live = 0;
    let totalAttempts = 0;
    let lastError: Error | null = null;
    const startedAt = Date.now();
    let lastProgressAt = 0;

    const cleanup = (): void => {
      for (const worker of workers) void worker.terminate();
    };
    const removeAbortListener = (): void => {
      signal?.removeEventListener("abort", onAbort);
    };
    const onAbort = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      removeAbortListener();
      reject(vanityAbortError());
    };
    if (signal) {
      if (signal.aborted) {
        reject(vanityAbortError());
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }

    const reportProgress = (force = false): void => {
      if (!onProgress) return;
      const now = Date.now();
      if (!force && now - lastProgressAt < 250) return;
      lastProgressAt = now;
      const progress: VanityGrindProgress = {
        attempts: totalAttempts,
        attemptsPerSecond: Math.round(
          (totalAttempts * 1000) / Math.max(1, now - startedAt)
        ),
      };
      onProgress(progress);
    };

    // Every worker died or could not be constructed: don't fail the launch —
    // grind on this thread with the yielding CJS-safe core instead.
    const fallbackSingleThread = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      removeAbortListener();
      void grindVanityMintKeypairSingleThread({
        suffix,
        onProgress,
        signal,
      }).then(resolve, (singleError: unknown) => {
        reject(
          singleError instanceof Error
            ? singleError
            : error instanceof Error
              ? error
              : new Error(String(error))
        );
      });
    };

    const spawn = (): void => {
      let worker: Worker;
      try {
        worker = new Worker(workerFile, { workerData: { suffix } });
      } catch (error) {
        // worker_threads unavailable / worker file missing: single-threaded
        // fallback (spawned workers, if any, are cleaned up there).
        fallbackSingleThread(error);
        return;
      }
      workers.push(worker);
      live += 1;
      worker.on("message", (message: NodeWorkerMessage): void => {
        if (message.type === "progress") {
          totalAttempts += message.attempts;
          reportProgress();
          return;
        }
        if (message.type === "found") {
          if (settled) return;
          settled = true;
          cleanup();
          removeAbortListener();
          // Structured clone already handed us an independent buffer; copy
          // once more so Keypair.fromSecretKey owns a stable 64 bytes.
          const secretKey = Uint8Array.from(message.secretKey);
          reportProgress(true);
          resolve(Keypair.fromSecretKey(secretKey));
          return;
        }
        // 'error': this worker died; if every worker dies, fall back to the
        // single-threaded core rather than failing the launch.
        live -= 1;
        lastError = new Error(message.message);
        if (live === 0 && !settled) fallbackSingleThread(lastError);
      });
      worker.on("error", (error: Error): void => {
        live -= 1;
        lastError = error;
        if (live === 0 && !settled) fallbackSingleThread(lastError);
      });
      worker.on("exit", (code: number): void => {
        // terminate() during cleanup races this handler; only count an
        // unexpected early exit (non-zero, and the worker already errored
        // out via 'error' otherwise) as a dead worker.
        if (code !== 0 && live > 0 && !settled) {
          live -= 1;
          if (live === 0) fallbackSingleThread(lastError ?? new Error(`vanity worker exited with code ${code}`));
        }
      });
    };

    for (let i = 0; i < workerCount; i += 1) spawn();
  });
}
