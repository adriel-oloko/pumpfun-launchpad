// Milestone M3 + M10: PumpSwap migration support on pump.fun's NATIVE
// program.
//
// M10: pump.fun auto-migrates its own curves at graduation (the buy that
// fills the curve migrates it to PumpSwap in the same instruction). The
// launchpad therefore NEVER calls a migrate instruction anymore —
// `migrateToPumpSwap` (the M3 client-driven migration of the CUSTOM program)
// is DELETED. What remains is the read side: deriving + looking up the
// PumpSwap pool a graduated pump.fun token migrated to (the pool PDA seeds
// from the curve's recorded creator), plus the generic PumpSwap SDK helpers
// (sendRawWithRetry, depositToPool) used by the M6 sell-all graduated leg.
//
// Exact SDK calls (verified in the Part A spike against a local validator
// with the PumpSwap program injected):
//   onlineSdk.createPoolSolanaState(index, creator, baseMint, quoteMint)
//   sdk.createPoolInstructions(createPoolSolanaState, baseIn, quoteIn)
//   onlineSdk.liquiditySolanaState(poolKey, user)
//   sdk.depositBaseInput(liquiditySolanaState, base, slippage)
//   sdk.depositInstructions(liquiditySolanaState, lpToken, slippage)
// PumpSwap itself and its WSOL quote mint are legacy SPL and UNCHANGED by
// the M10 swap (pump.fun token mints are also legacy SPL now).

import { BN } from "@coral-xyz/anchor";
import { OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import { readPumpCurveState } from "./pump";
import { isBlockhashExpiredError, isOnChainRevert } from "./tx-errors";

/** PumpSwap AMM program id (mainnet; injected into the local validator for
 *  tests, see Anchor.toml + tests/fixtures). */
export const PUMP_AMM_PROGRAM_ID = new PublicKey(
  "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA"
);

/** Quote mint of every PumpSwap pool: wrapped SOL. */
export const WSOL_MINT = new PublicKey(
  "So11111111111111111111111111111111111111112"
);

/** Pool index seed used by this launchpad's pools (0 like pump.fun's
 *  CANONICAL_POOL_INDEX; the index is a u16, 2-byte little-endian seed). */
export const CANONICAL_POOL_INDEX = 0;

/** Pool PDA: ["pool", index_u16_le, creator, baseMint, quoteMint] under the
 *  PumpSwap program, replicated from the SDK's poolPda(). */
export function pumpSwapPoolPda(
  index: number,
  creator: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): [PublicKey, number] {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(index, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      indexBuf,
      creator.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    PUMP_AMM_PROGRAM_ID
  );
}

/** LP mint PDA: ["pool_lp_mint", pool] under the PumpSwap program. */
export function pumpSwapLpMintPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), pool.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

/** The PumpSwap pool a graduated mint migrated to, plus the migration
 *  creator it was seeded under. Derives the canonical pool PDA
 *  (["pool", index_le, creator, baseMint, quoteMint]) from the curve's
 *  recorded creator, exactly as pump.fun's auto-migration seeded it. The
 *  creator is read from the PUMP.FUN curve state (bonding-curve PDA layout
 *  in lib/pump.ts), NOT an anchor curve account. The pool account only
 *  EXISTS after migration ran (devnet has no PumpSwap, so on devnet the
 *  caller must treat a missing account as "not migrated yet"); this helper
 *  returns the derivation regardless so callers can distinguish "pool
 *  absent" from "not graduated". */
export interface MigratedPoolLookup {
  /** The migration creator = pump curve creator (receives the released SOL
   *  at graduation and seeded the PumpSwap createPool). */
  creator: PublicKey;
  /** Curve `complete` flag (pool derivation is only meaningful after). */
  graduated: boolean;
  /** Derived PumpSwap pool PDA for the mint. */
  poolKey: PublicKey;
  poolBump: number;
}

export async function lookupMigratedPool(
  connection: Connection,
  mint: PublicKey,
  index: number = CANONICAL_POOL_INDEX
): Promise<MigratedPoolLookup> {
  const read = await readPumpCurveState(connection, mint);
  if (read.kind === "missing") {
    throw new Error(
      `curve for mint ${mint.toBase58()} not found (not a pump.fun token?)`
    );
  }
  const curve = read.curve;
  const [poolKey, poolBump] = pumpSwapPoolPda(
    index,
    curve.creator,
    mint,
    WSOL_MINT
  );
  return {
    creator: curve.creator,
    graduated: curve.complete,
    poolKey,
    poolBump,
  };
}

/** Sends a raw transaction with skipPreflight and retries. The PumpSwap
 *  program is ~10MB, so the first execution JIT-compiles it (slow) and a
 *  cold-cache race can surface ProgramCacheHitMaxLimit once; retrying with a
 *  fresh blockhash is the robust local-validator pattern. */
export async function sendRawWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts: { attempts?: number; waitMs?: number; confirmTimeoutMs?: number } = {}
): Promise<string> {
  const attempts = opts.attempts ?? 5;
  const waitMs = opts.waitMs ?? 2_000;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 120_000;
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    const latest = await connection.getLatestBlockhash("confirmed");
    tx.recentBlockhash = latest.blockhash;
    tx.lastValidBlockHeight = latest.lastValidBlockHeight;
    tx.sign(...signers);
    try {
      const signature = await connection.sendRawTransaction(tx.serialize(), {
        skipPreflight: true,
      });
      const confirmed = await Promise.race([
        connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        ),
        new Promise<never>((_, reject) =>
          setTimeout(
            () => reject(new Error(`confirm timed out after ${confirmTimeoutMs}ms`)),
            confirmTimeoutMs
          )
        ),
      ]);
      if (confirmed.value.err) {
        throw new Error(
          `transaction failed on chain: ${JSON.stringify(confirmed.value.err)}`
        );
      }
      return signature;
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (
        msg.includes("ProgramCacheHitMaxLimit") ||
        msg.includes("hit max limit")
      ) {
        // Cold-cache race: the program is loaded but the batch aborted.
        // Retry immediately; the next batch hits the cached entry.
        await new Promise((r) => setTimeout(r, 1_000));
        continue;
      }
      // A definite on-chain revert cannot be fixed by re-sending: stop
      // instead of burning the remaining attempts on a doomed tx.
      if (isOnChainRevert(msg)) break;
      // Blockhash expired while the 10MB program JIT-compiled: retry with a
      // fresh blockhash right away (the loop re-fetches one at the top).
      if (isBlockhashExpiredError(msg)) {
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      // Anything else (transport blips, rate limits): paced retry.
      await new Promise((r) => setTimeout(r, waitMs));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`sendRawWithRetry exhausted ${attempts} attempts`);
}

export interface DepositResult {
  baseIn: bigint;
  quoteIn: bigint;
  lpOut: bigint;
  poolBaseReserve: bigint;
  poolQuoteReserve: bigint;
}

/** Deposits liquidity into an existing PumpSwap pool via the SDK (proves the
 *  deposit path used after migration and by M6's pool-side flows). The SDK
 *  wraps the WSOL side internally, same as createPool. The SDK's slippage is
 *  a percentage in [0, 100] (1 = 1%), so the caller passes percent here. */
export async function depositToPool(
  connection: Connection,
  poolKey: PublicKey,
  user: Keypair,
  baseIn: bigint,
  slippagePct = 1
): Promise<DepositResult> {
  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const liqState = await onlineSdk.liquiditySolanaState(poolKey, user.publicKey);
  const beforeBase = BigInt(liqState.poolBaseTokenAccount.amount.toString());
  const beforeQuote = BigInt(liqState.poolQuoteTokenAccount.amount.toString());
  const { lpToken } = sdk.depositBaseInput(
    liqState,
    new BN(baseIn.toString()),
    slippagePct
  );
  const depositIxs = await sdk.depositInstructions(
    liqState,
    lpToken,
    slippagePct
  );
  const tx = new Transaction();
  tx.add(...depositIxs);
  tx.feePayer = user.publicKey;
  await sendRawWithRetry(connection, tx, [user]);

  // Re-read the pool state after the deposit for the exact reserves. The
  // SDK's LiquiditySolanaState exposes the decoded pool token accounts
  // (RawAccount) with their balances. baseIn/quoteIn are the ACTUAL reserves
  // delta (the SDK's maxBase/maxQuote are slippage ceilings, not what moved).
  const after = await onlineSdk.liquiditySolanaState(poolKey, user.publicKey);
  const afterBase = BigInt(after.poolBaseTokenAccount.amount.toString());
  const afterQuote = BigInt(after.poolQuoteTokenAccount.amount.toString());
  return {
    baseIn: afterBase - beforeBase,
    quoteIn: afterQuote - beforeQuote,
    lpOut: BigInt(lpToken.toString()),
    poolBaseReserve: afterBase,
    poolQuoteReserve: afterQuote,
  };
}
