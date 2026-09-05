// Single source of truth for WHICH Solana cluster the app talks to.
//
// NEXT_PUBLIC_SOLANA_NETWORK=mainnet|devnet (default devnet). NEXT_PUBLIC_
// vars are inlined at build time in every module that reads them, so the
// whole client (RPC pool, fee-recipient constants, explorer links) follows
// the SAME value per build. Set it to `mainnet` in .env.local to move the
// app onto mainnet; leave it unset (or `devnet`) for devnet rehearsals.
//
// Devnet stays the fallback so a fresh checkout never silently talks to
// mainnet (real money) until an operator flips the flag on purpose.

export type SolanaNetwork = 'mainnet' | 'devnet'

/** The app's cluster: NEXT_PUBLIC_SOLANA_NETWORK, defaulting to devnet. */
export function solanaNetwork(): SolanaNetwork {
    const v = (process.env.NEXT_PUBLIC_SOLANA_NETWORK ?? '')
        .trim()
        .toLowerCase()
    return v === 'mainnet' ? 'mainnet' : 'devnet'
}
