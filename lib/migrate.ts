// Milestone M3: client-driven PumpSwap migration (Option B, confirmed by
// product). The program graduates the curve on-chain; this module reads the
// graduated curve, wraps the released real SOL to WSOL, seeds a PumpSwap pool
// via the official @pump-fun/pump-swap-sdk, and honors the per-token lock_lp
// flag by burning the LP (the real pump.fun model: LP mint authority stays the
// pool PDA, LP tokens are burned at migration, withdraw becomes impossible).
//
// This module is off-chain by design: the program never CPIs into PumpSwap.
// The M4 UI will invoke the same functions after graduation.
//
// Exact SDK calls (verified in the Part A spike against a local validator with
// the PumpSwap program injected):
//   onlineSdk.createPoolSolanaState(index, creator, baseMint, quoteMint)
//   sdk.createPoolInstructions(createPoolSolanaState, baseIn, quoteIn)
//   onlineSdk.liquiditySolanaState(poolKey, user)
//   sdk.depositBaseInput(liquiditySolanaState, base, slippage)
//   sdk.depositInstructions(liquiditySolanaState, lpToken, slippage)
// createPool takes base_amount_in / quote_amount_in directly, so the pool is
// seeded in one instruction; no separate initial deposit is needed. The SDK
// wraps WSOL internally when the quote mint is the native mint (creates the
// WSOL ATA, transfers lamports, syncs native, runs createPool, closes the
// account and unwraps the leftover).

import { BN } from "@coral-xyz/anchor";
import { OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  createBurnInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
} from "@solana/web3.js";
import {
  TOTAL_SUPPLY,
  VIRTUAL_SOL_RESERVE,
} from "./params";
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

/** PDA seed prefixes, replicated exactly from programs/pumpfun/src/lib.rs. */
export const CURVE_SEED = Buffer.from("curve");
export const MINT_SEED = Buffer.from("mint");
export const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");

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

/** Creator's LP ATA (Token-2022, allowOwnerOffCurve=true) - the account the
 *  AMM program mints LP into at createPool. */
export function creatorLpAta(lpMint: PublicKey, creator: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(
    lpMint,
    creator,
    true,
    TOKEN_2022_PROGRAM_ID
  );
}

/** Curve-state PDA: ["curve", mint]. */
export function curveStatePda(
  programId: PublicKey,
  mint: PublicKey
): PublicKey {
  return PublicKey.findProgramAddressSync(
    [CURVE_SEED, mint.toBuffer()],
    programId
  )[0];
}

/** The PumpSwap pool a graduated mint migrated to, plus the migration
 *  creator it was seeded under. Derives the canonical pool PDA
 *  (["pool", index_le, creator, baseMint, quoteMint]) from the curve's
 *  recorded creator, exactly as migrateToPumpSwap seeded it. The pool
 *  account only EXISTS after migration ran (devnet has no PumpSwap, so on
 *  devnet the caller must treat a missing account as "not migrated yet");
 *  this helper returns the derivation regardless so callers can distinguish
 *  "pool absent" from "not graduated". */
export interface MigratedPoolLookup {
  /** The migration creator = curve_state.creator (receives the released SOL
   *  at graduation and signs the SDK createPool). */
  creator: PublicKey;
  /** Curve graduated flag (pool derivation is only meaningful after). */
  graduated: boolean;
  /** Derived PumpSwap pool PDA for the mint. */
  poolKey: PublicKey;
  poolBump: number;
}

export async function lookupMigratedPool(
  program: CurveProgram,
  mint: PublicKey,
  index: number = CANONICAL_POOL_INDEX
): Promise<MigratedPoolLookup> {
  const curveKey = curveStatePda(program.programId, mint);
  const curve = await program.account.curveStateAccount.fetch(curveKey);
  const [poolKey, poolBump] = pumpSwapPoolPda(
    index,
    curve.creator,
    mint,
    WSOL_MINT
  );
  return {
    creator: curve.creator,
    graduated: curve.graduated,
    poolKey,
    poolBump,
  };
}

/** Effective-raised approximation of the real SOL the curve collected:
 *  sol_reserve (the ledger: 30 SOL virtual + real effective deposits) minus
 *  the 30 SOL virtual reserve. The graduate instruction releases the exact
 *  amount the vault holds (every lamport above its rent-exempt floor, see
 *  graduate_impl in the program): callers that know it (e.g. measured from
 *  the creator wallet balance delta at graduation) must pass that exact
 *  amount; this helper is only the fallback when it is unknown, and it
 *  excludes the 1% protocol fees that stay in the vault. */
export function realSolLamports(curve: {
  solReserve: BN | bigint;
}): bigint {
  const solReserve =
    typeof curve.solReserve === "bigint"
      ? curve.solReserve
      : BigInt(curve.solReserve.toString());
  return solReserve - VIRTUAL_SOL_RESERVE;
}

/** Remaining supply the graduate instruction minted to the creator:
 *  TOTAL_SUPPLY - supply_out. */
export function remainingSupply(curve: { supplyOut: BN | bigint }): bigint {
  const supplyOut =
    typeof curve.supplyOut === "bigint"
      ? curve.supplyOut
      : BigInt(curve.supplyOut.toString());
  return TOTAL_SUPPLY - supplyOut;
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

export interface MigrateResult {
  poolKey: PublicKey;
  poolBump: number;
  lpMint: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  /** Base amount deposited (raw token units). */
  baseAmount: bigint;
  /** Quote amount deposited (lamports of WSOL). */
  quoteAmount: bigint;
  /** Pool's LP supply bookkeeping after createPool. */
  lpSupply: bigint;
  /** Creator's LP token balance after createPool (and after the burn when
   *  lock_lp was honored). */
  creatorLpBalance: bigint;
  /** True when the LP was burned (lock_lp honored). */
  lpLocked: boolean;
}

/** The on-chain curve state fields the migration reads (typed structurally so
 *  this module does not depend on the generated IDL types). */
export interface CurveStateLike {
  /** The recorded creator (set at create(); receives the released SOL and
   *  remaining supply at graduation and is the PumpSwap pool creator). */
  creator: PublicKey;
  graduated: boolean;
  lockLp: boolean;
  solReserve: BN | bigint;
  supplyOut: BN | bigint;
}

/** Anchor program instance narrowed to the account namespace the migration
 *  reads (curveStateAccount.fetch). */
export interface CurveProgram {
  programId: PublicKey;
  account: {
    curveStateAccount: {
      fetch(address: PublicKey): Promise<CurveStateLike>;
    };
  };
}

export interface MigrateOptions {
  connection: Connection;
  /** The token creator wallet; owns the released real SOL and the remaining
   *  supply, signs the createPool tx (and the LP burn when locking). */
  creator: Keypair;
  /** Anchor program instance for the launchpad program. */
  program: CurveProgram;
  /** The graduated token mint (base mint of the pool). */
  mint: PublicKey;
  /** Real SOL to seed the pool with, in lamports. When omitted, defaults to
   *  the effective-raised approximation (realSolLamports). */
  quoteLamports?: bigint;
  /** Pool index seed (default CANONICAL_POOL_INDEX). */
  index?: number;
  /** Override the curve's stored lock_lp flag. */
  lockLp?: boolean;
}

/** Migrates a graduated curve to a PumpSwap pool: SDK createPool with the
 *  released WSOL + remaining supply, then LP burn when lock_lp is set. */
export async function migrateToPumpSwap(
  opts: MigrateOptions
): Promise<MigrateResult> {
  const {
    connection,
    creator,
    program,
    mint,
    index = CANONICAL_POOL_INDEX,
  } = opts;

  // 1. Read the curve; it must be graduated (buy/sell are closed, the funds
  //    were released to the creator).
  const curveKey = curveStatePda(program.programId, mint);
  const curve = await program.account.curveStateAccount.fetch(curveKey);
  if (!curve.graduated) {
    throw new Error(`curve ${curveKey.toBase58()} is not graduated`);
  }

  const baseAmount = remainingSupply(curve);
  const quoteAmount =
    opts.quoteLamports !== undefined
      ? opts.quoteLamports
      : realSolLamports(curve);
  if (baseAmount <= BigInt(0)) {
    throw new Error(`no remaining supply to migrate for ${mint.toBase58()}`);
  }
  if (quoteAmount <= BigInt(0)) {
    throw new Error(`no real SOL to migrate for ${mint.toBase58()}`);
  }
  const lockLp = opts.lockLp ?? curve.lockLp;

  // 2. SDK state + instructions. The SDK wraps the quote lamports to WSOL
  //    internally (create WSOL ATA, transfer, syncNative, close after).
  const onlineSdk = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const createState = await onlineSdk.createPoolSolanaState(
    index,
    creator.publicKey,
    mint,
    WSOL_MINT
  );
  const poolKey = createState.poolKey;
  const createIxs = await sdk.createPoolInstructions(
    createState,
    new BN(baseAmount.toString()),
    new BN(quoteAmount.toString())
  );

  const tx = new Transaction();
  tx.add(...createIxs);
  tx.feePayer = creator.publicKey;
  await sendRawWithRetry(connection, tx, [creator]);

  // 3. Read the pool back and its reserves.
  const poolInfo = await connection.getAccountInfo(poolKey);
  if (!poolInfo) {
    throw new Error(`pool ${poolKey.toBase58()} missing after createPool`);
  }
  const pool = sdk.decodePool(poolInfo);
  const lpMint = new PublicKey(pool.lpMint);
  const creatorLpKey = creatorLpAta(lpMint, creator.publicKey);

  let creatorLpBal = BigInt(0);
  try {
    const lpBal = await connection.getTokenAccountBalance(creatorLpKey);
    creatorLpBal = BigInt(lpBal.value.amount);
  } catch {
    creatorLpBal = BigInt(0);
  }

  // 4. Lock the LP when the token opted in: burn every LP token from the
  //    creator's ATA (the real pump.fun model; the LP mint authority stays
  //    the pool PDA, so burning is the lock).
  let lpLocked = false;
  if (lockLp && creatorLpBal > BigInt(0)) {
    const burnIx = createBurnInstruction(
      creatorLpKey,
      lpMint,
      creator.publicKey,
      creatorLpBal,
      [],
      TOKEN_2022_PROGRAM_ID
    );
    const burnTx = new Transaction().add(burnIx);
    burnTx.feePayer = creator.publicKey;
    await sendRawWithRetry(connection, burnTx, [creator]);
    creatorLpBal = BigInt(0);
    lpLocked = true;
  }

  return {
    poolKey,
    poolBump: pool.poolBump,
    lpMint,
    poolBaseTokenAccount: createState.poolBaseTokenAccount,
    poolQuoteTokenAccount: createState.poolQuoteTokenAccount,
    baseAmount,
    quoteAmount,
    lpSupply: BigInt(pool.lpSupply.toString()),
    creatorLpBalance: creatorLpBal,
    lpLocked,
  };
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

export {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
};
