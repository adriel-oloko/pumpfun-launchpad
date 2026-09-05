// Client-side Solana connection factory.
//
// Every read in the browser UI (roster balance poll, quotes, curve state)
// funnels through ONE Connection whose custom fetch is the health-aware
// rotatingFetch over the app network's RPC pool (lib/rpc/rpc-pool.ts),
// which in turn passes every HTTP request through the shared rate limiter
// (lib/rpc/rpc-limiter.ts). Which network the app is on is decided once in
// lib/network.ts (NEXT_PUBLIC_SOLANA_NETWORK, default devnet); call sites
// use makeAppConnection and never think about clusters.
//
// A defensive global Buffer is installed because @solana/web3.js and
// @coral-xyz/anchor import the `buffer` package directly (never the global),
// but a few transitive paths assume a browser global. The package ships in
// node_modules (transitive dep of web3.js v1); this just mirrors it onto
// globalThis when the bundler did not.

import { Connection } from '@solana/web3.js'
import { Buffer } from 'buffer'
import { solanaNetwork } from './network'
import {
    DEVNET_RPC_POOL,
    MAINNET_RPC_POOL,
    rotatingFetch,
} from './rpc/rpc-pool'

if (
    typeof globalThis !== 'undefined' &&
    typeof (globalThis as { Buffer?: unknown }).Buffer === 'undefined'
) {
    ;(globalThis as { Buffer: typeof Buffer }).Buffer = Buffer
}

/** Builds a Connection over one RPC pool with the rotating pool transport. */
function makePooledConnection(pool: string[]): Connection {
    return new Connection(
        pool[0] ??
            'https://mainnet.helius-rpc.com/?api-key=6fd05d57-a073-4cc6-8b5b-4314a652e487',
        {
            commitment: 'confirmed',
            fetch: (input: RequestInfo | URL, init?: RequestInit) =>
                rotatingFetch(pool, input, init),
        }
    )
}

/** Builds a devnet Connection (devnet rehearsals, keyed RPC overrides). */
export function makeDevnetConnection(): Connection {
    return makePooledConnection(DEVNET_RPC_POOL)
}

/** Builds a mainnet Connection (real launches; requires a funded wallet). */
export function makeMainnetConnection(): Connection {
    return makePooledConnection(MAINNET_RPC_POOL)
}

/** Builds a Connection for the app's configured network (mainnet|devnet). */
export function makeAppConnection(): Connection {
    return solanaNetwork() === 'mainnet'
        ? makeMainnetConnection()
        : makeDevnetConnection()
}
