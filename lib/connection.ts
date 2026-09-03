// Client-side Solana connection factory.
//
// Every read in the browser UI (roster balance poll, quotes, curve state)
// funnels through ONE Connection whose custom fetch is the health-aware
// rotatingFetch over the devnet RPC pool (lib/rpc/rpc-pool.ts), which in
// turn passes every HTTP request through the shared rate limiter
// (lib/rpc/rpc-limiter.ts). This is the M0 decision applied at the
// transport layer; call sites never know about rotation or throttling.
//
// A defensive global Buffer is installed because @solana/web3.js and
// @coral-xyz/anchor import the `buffer` package directly (never the global),
// but a few transitive paths assume a browser global. The package ships in
// node_modules (transitive dep of web3.js v1); this just mirrors it onto
// globalThis when the bundler did not.

import { Connection } from "@solana/web3.js";
import { Buffer } from "buffer";
import { DEVNET_RPC_POOL, rotatingFetch } from "./rpc/rpc-pool";

if (typeof globalThis !== "undefined" && typeof (globalThis as { Buffer?: unknown }).Buffer === "undefined") {
  (globalThis as { Buffer: typeof Buffer }).Buffer = Buffer;
}

/** Builds a devnet Connection with the rotating RPC pool as its transport. */
export function makeDevnetConnection(): Connection {
  return new Connection("https://api.devnet.solana.com", {
    commitment: "confirmed",
    fetch: (input: RequestInfo | URL, init?: RequestInit) =>
      rotatingFetch(DEVNET_RPC_POOL, input, init),
  });
}
