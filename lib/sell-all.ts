// Milestone M6: the SELL ALL engine.
//
// One call sells every managed wallet's full token balance of a mint,
// routed by the on-chain curve state (the key part):
//
//   - NOT GRADUATED: the curve is still open, so each wallet sells through
//     the pumpfun program's sell(token_in) instruction (100% of its token
//     balance, per the bonding-curve math).
//   - GRADUATED: the curve is closed (sell reverts with AlreadyGraduated);
//     each wallet instead swaps its full balance to WSOL on the PumpSwap
//     pool via the official @pump-fun/pump-swap-sdk (sellBaseInput quotes a
//     fresh minAmountOut from the pool reserves under the slippage band).
//     The SDK's sell instruction stream closes the WSOL account in the same
//     transaction (quote mint = native mint), so each wallet ends up with
//     native SOL, no leftover WSOL ATA.
//
// Wallets without a key (watch-only) or with a zero token balance are
// skipped. The per-wallet sells run CONCURRENTLY (Promise.allSettled, the
// v4 multi-wallet batch pattern) and the caller is handed the final
// completed count plus a per-wallet report (route, signature, SOL
// received) and the holder count measured after the run.
//
// Browser-safe: this module only builds/signs with Keypairs and reads the
// chain through the passed Connection/Program; it never imports the anchor
// Wallet class (Node-only).

import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { holderCount, walletTokenBalance } from "./bundle/launch";
import { friendlyTxError } from "./tx-errors";
import {
  CANONICAL_POOL_INDEX,
  curveStatePda,
  lookupMigratedPool,
  sendRawWithRetry,
  type CurveProgram,
} from "./migrate";

/** The curve account fields this engine quotes against (structural; anchor
 *  account fetches return camelCase names at runtime). */
export interface CurveAccountLike {
  creator: PublicKey;
  graduated: boolean;
  lockLp: boolean;
  /** Virtual + real SOL reserve, lamports. */
  solReserve: BN | bigint;
  /** Virtual token reserve, raw units. */
  tokenReserve: BN | bigint;
  /** Cumulative tokens minted (monotonic). */
  supplyOut: BN | bigint;
  /** Protocol fee, basis points (100 = 1%). */
  feeBps: BN | bigint;
}

/** Narrow program surface the engine needs: encode the curve sell
 *  instruction (program.methods.sell(...).accounts(...).instruction()) and
 *  fetch the curve account. The real anchor Program satisfies this shape;
 *  call sites cast at the boundary (same pattern as lib/migrate's
 *  CurveProgram). */
export interface SellAllProgram extends CurveProgram {
  account: {
    curveStateAccount: {
      fetch(address: PublicKey): Promise<CurveAccountLike>;
    };
  };
  methods: {
    sell: (tokenIn: BN) => {
      accounts(args: {
        seller: PublicKey;
        mint: PublicKey;
        curveState: PublicKey;
        sellerAta: PublicKey;
        systemProgram: PublicKey;
        token2022Program: PublicKey;
      }): {
        instruction(): Promise<TransactionInstruction>;
      };
    };
  };
}

/** A managed roster wallet the engine can sell for (key optional: wallets
 *  without a base58 secret are skipped, watch-only rows never sign). */
export interface SellableWallet {
  address: string;
  key?: string;
}

export type SellRoute = "curve" | "pumpSwap";

export interface SellOutcome {
  address: string;
  /** The venue actually used for this wallet's sell. */
  route: SellRoute;
  status: "sold" | "skipped" | "failed";
  /** Skip/failure reason (short, human label). */
  reason?: string;
  /** Raw token units sold (0 when skipped/failed). */
  tokenSold: bigint;
  /** Native SOL lamports received, measured as the wallet's SOL balance
   *  delta across the sell (nets the ~5000-lamport tx fee; 0 when
   *  skipped/failed). */
  solReceivedLamports: bigint;
  /** Confirmed transaction signature (only when sold). */
  signature?: string;
}

export interface SellAllOptions {
  connection: Connection;
  program: SellAllProgram;
  /** The token mint to sell (curve mint = PumpSwap base mint). */
  mint: PublicKey;
  /** The managed roster; keyed wallets are sold, watch-only skipped. */
  wallets: SellableWallet[];
  /** PumpSwap slippage percent for the graduated leg (default 5). */
  slippagePct?: number;
  /** PumpSwap pool index seed (default CANONICAL_POOL_INDEX = 0). */
  poolIndex?: number;
}

export interface SellAllReport {
  route: SellRoute;
  /** Curve graduated flag that chose the route. */
  graduated: boolean;
  /** The curve creator (the PumpSwap pool creator once graduated). */
  creator: string;
  /** Derived PumpSwap pool (only meaningful once graduated). */
  poolKey: string | null;
  /** Managed wallets considered. */
  total: number;
  /** Wallets skipped (no key / zero balance). */
  skipped: number;
  /** Wallets that failed (their sells were attempted). */
  failed: number;
  /** FINAL COMPLETED COUNT (the only headline number; v4 batch pattern). */
  sold: number;
  outcomes: SellOutcome[];
  /** Holder count after the run (null when the RPC read failed). */
  holderCountAfter: number | null;
}

/** Converts a BN or bigint curve field to a plain bigint. */
function toBig(v: BN | bigint): bigint {
  return typeof v === "bigint" ? v : BigInt(v.toString());
}

/** Mirrors programs/pumpfun/src/curve_math.rs sell(): fee is charged on the
 *  token input, then sol_out = solReserve * effective / (tokenReserve +
 *  effective). Returns null when the sell would revert on chain (zero
 *  effective input, or effective >= tokenReserve draining the curve). */
export function quoteCurveSellLamports(
  curve: CurveAccountLike,
  tokenIn: bigint
): bigint | null {
  if (tokenIn <= BigInt(0)) return null;
  const solReserve = toBig(curve.solReserve);
  const tokenReserve = toBig(curve.tokenReserve);
  const feeBps = toBig(curve.feeBps);
  const keepBps = BigInt(10000) - feeBps;
  const effective = (tokenIn * keepBps) / BigInt(10000);
  if (effective <= BigInt(0)) return null;
  if (effective >= tokenReserve) return null;
  if (solReserve <= BigInt(0)) return null;
  return (solReserve * effective) / (tokenReserve + effective);
}

/** Builds the bonding-curve sell instruction for one wallet's full balance
 *  (the NOT-graduated route). */
async function buildCurveSellIx(
  program: SellAllProgram,
  seller: PublicKey,
  mint: PublicKey,
  curveState: PublicKey,
  tokenIn: bigint
): Promise<TransactionInstruction> {
  const sellerAta = getAssociatedTokenAddressSync(
    mint,
    seller,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  return program.methods
    .sell(new BN(tokenIn.toString()))
    .accounts({
      seller,
      mint,
      curveState,
      sellerAta,
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
    })
    .instruction();
}

/** True when a failure is a transient RPC/pool condition worth retrying
 *  (rate limits, endpoint backoff, transport errors, timeouts). On-chain
 *  reverts and user/balance errors are NOT transient. */
function isTransientRpcError(msg: string): boolean {
  return /pool exhausted|rate ?limit|429|408|503|502|failed to fetch|network error|socket|timed? ?out|timeout|econnreset|econnrefused|etimedout|fetch failed|blockhash not found/i.test(
    msg
  );
}

function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Per-wallet sell attempts: a wallet keeps retrying transient RPC failures
 *  (public devnet rate-limits bursts; the pool cools down for 45s after one
 *  429) with a growing gap, re-reading the balance before every attempt so a
 *  tx that actually landed despite a lost confirm is detected (balance 0 on
 *  a later attempt = the tokens already sold). */
const SELL_ATTEMPTS = 4;
const SELL_RETRY_BASE_MS = 8_000;

function skippedOutcome(address: string, route: SellRoute): SellOutcome {
  return {
    address,
    route,
    status: "skipped",
    reason: "zero token balance",
    tokenSold: BigInt(0),
    solReceivedLamports: BigInt(0),
  };
}

function failedOutcome(
  address: string,
  route: SellRoute,
  e: unknown
): SellOutcome {
  const raw = e instanceof Error ? e.message : String(e);
  // M7a: surface an actionable reason for rate-limit / expired blockhash /
  // insufficient-funds / rent classes instead of the raw RPC text.
  const friendly = friendlyTxError(raw);
  const msg = friendly.length > 180 ? `${friendly.slice(0, 177)}...` : friendly;
  return {
    address,
    route,
    status: "failed",
    reason: msg,
    tokenSold: BigInt(0),
    solReceivedLamports: BigInt(0),
  };
}

/** Sells one keyed wallet's full balance on the bonding curve, confirming
 *  the tx and measuring the native SOL the wallet received. Retries
 *  transient RPC failures with backoff. */
async function sellOneCurve(
  connection: Connection,
  program: SellAllProgram,
  mint: PublicKey,
  curveState: PublicKey,
  curve: CurveAccountLike,
  wallet: Keypair
): Promise<SellOutcome> {
  const address = wallet.publicKey.toBase58();
  let firstBalance = BigInt(0);
  let lastSolBefore = BigInt(0);
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt++) {
    try {
      const balance = await walletTokenBalance(connection, wallet.publicKey, mint);
      if (attempt === 1) firstBalance = balance;
      if (balance <= BigInt(0)) {
        // Zero now: either it was always zero (skip) or a previous attempt
        // actually landed but its confirm was lost (report as sold).
        if (firstBalance > BigInt(0)) {
          let solNow = lastSolBefore;
          try {
            solNow = BigInt(
              await connection.getBalance(wallet.publicKey, "confirmed")
            );
          } catch {
            // keep the last known before-balance; the report falls back to 0
          }
          return {
            address,
            route: "curve",
            status: "sold",
            reason: "balance drained after a previous attempt (signature lost to RPC)",
            tokenSold: firstBalance,
            solReceivedLamports: BigInt(
              Math.max(0, Number(solNow - lastSolBefore))
            ),
          };
        }
        return skippedOutcome(address, "curve");
      }
      lastSolBefore = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      const ix = await buildCurveSellIx(
        program,
        wallet.publicKey,
        mint,
        curveState,
        balance
      );
      const tx = new Transaction({ feePayer: wallet.publicKey });
      tx.add(ix);
      const signature = await sendRawWithRetry(connection, tx, [wallet], {
        confirmTimeoutMs: 90_000,
      });
      const solAfter = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      return {
        address,
        route: "curve",
        status: "sold",
        tokenSold: balance,
        solReceivedLamports: BigInt(Math.max(0, Number(solAfter - lastSolBefore))),
        signature,
      };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      if (!isTransientRpcError(msg) || attempt >= SELL_ATTEMPTS) {
        break;
      }
      await sleepMs(SELL_RETRY_BASE_MS * attempt);
    }
  }
  return failedOutcome(address, "curve", lastErr ?? new Error("sell failed"));
}

/** Sells one keyed wallet's full balance on PumpSwap (the graduated route):
 *  SDK sellBaseInput quotes a fresh minQuoteAmountOut from the pool state
 *  under the slippage band and returns the instruction stream, which closes
 *  the wallet's WSOL account so the proceeds land as native SOL. Retries
 *  transient RPC failures with backoff. */
async function sellOnePumpSwap(
  connection: Connection,
  mint: PublicKey,
  poolKey: PublicKey,
  wallet: Keypair,
  slippagePct: number
): Promise<SellOutcome> {
  const address = wallet.publicKey.toBase58();
  let firstBalance = BigInt(0);
  let lastSolBefore = BigInt(0);
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= SELL_ATTEMPTS; attempt++) {
    try {
      const balance = await walletTokenBalance(connection, wallet.publicKey, mint);
      if (attempt === 1) firstBalance = balance;
      if (balance <= BigInt(0)) {
        if (firstBalance > BigInt(0)) {
          let solNow = lastSolBefore;
          try {
            solNow = BigInt(
              await connection.getBalance(wallet.publicKey, "confirmed")
            );
          } catch {
            // keep the last known before-balance; the report falls back to 0
          }
          return {
            address,
            route: "pumpSwap",
            status: "sold",
            reason: "balance drained after a previous attempt (signature lost to RPC)",
            tokenSold: firstBalance,
            solReceivedLamports: BigInt(
              Math.max(0, Number(solNow - lastSolBefore))
            ),
          };
        }
        return skippedOutcome(address, "pumpSwap");
      }
      const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
      if (!poolInfo) {
        throw new Error(
          `PumpSwap pool ${poolKey.toBase58()} not found (not migrated?)`
        );
      }
      lastSolBefore = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      const onlineSdk = new OnlinePumpAmmSdk(connection);
      const sdk = new PumpAmmSdk();
      const swapState = await onlineSdk.swapSolanaState(poolKey, wallet.publicKey);
      const ixs = await sdk.sellBaseInput(
        swapState,
        new BN(balance.toString()),
        slippagePct
      );
      const tx = new Transaction({ feePayer: wallet.publicKey });
      tx.add(...ixs);
      const signature = await sendRawWithRetry(connection, tx, [wallet], {
        confirmTimeoutMs: 120_000,
      });
      const solAfter = BigInt(
        await connection.getBalance(wallet.publicKey, "confirmed")
      );
      return {
        address,
        route: "pumpSwap",
        status: "sold",
        tokenSold: balance,
        solReceivedLamports: BigInt(
          Math.max(0, Number(solAfter - lastSolBefore))
        ),
        signature,
      };
    } catch (e) {
      lastErr = e;
      const msg = e instanceof Error ? e.message : String(e);
      // A missing pool is a hard (permanent) condition, not transient; pool
      // rate-limit exhaustion IS transient and must keep retrying.
      const poolMissing = /not found \(not migrated\?\)/.test(msg);
      if (
        poolMissing ||
        !isTransientRpcError(msg) ||
        attempt >= SELL_ATTEMPTS
      ) {
        break;
      }
      await sleepMs(SELL_RETRY_BASE_MS * attempt);
    }
  }
  return failedOutcome(address, "pumpSwap", lastErr ?? new Error("sell failed"));
}

/** The SELL ALL entry point. Reads the curve state once to choose the route,
 *  then sells every keyed wallet's full balance concurrently. Never throws
 *  for a per-wallet failure: each wallet's error is captured in its outcome
 *  and the final report carries the completed count. */
export async function sellAllManagedWallets(
  opts: SellAllOptions
): Promise<SellAllReport> {
  const {
    connection,
    program,
    mint,
    wallets,
    slippagePct = 5,
    poolIndex = CANONICAL_POOL_INDEX,
  } = opts;

  // ROUTING: read the curve state once. NOT graduated -> the curve sell
  // instruction; graduated -> the PumpSwap pool the curve migrated to
  // (derived from the recorded creator, index 0).
  const curveState = curveStatePda(program.programId, mint);
  const curve = await program.account.curveStateAccount.fetch(curveState);
  const graduated = curve.graduated;
  const creator = curve.creator.toBase58();

  let poolKey: PublicKey | null = null;
  if (graduated) {
    const lookup = await lookupMigratedPool(program, mint, poolIndex);
    poolKey = lookup.poolKey;
  }
  const route: SellRoute = graduated ? "pumpSwap" : "curve";

  // Each keyed roster wallet signs and pays for its own sell; watch-only
  // rows (no key) are skipped. Per-wallet sells run concurrently.
  const workers = wallets
    .filter((w) => w.key)
    .map(async (w): Promise<SellOutcome> => {
      const secret = w.key as string;
      const wallet = Keypair.fromSecretKey(bs58.decode(secret));
      try {
        if (route === "curve") {
          return await sellOneCurve(
            connection,
            program,
            mint,
            curveState,
            curve,
            wallet
          );
        }
        return await sellOnePumpSwap(
          connection,
          mint,
          poolKey as PublicKey,
          wallet,
          slippagePct
        );
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          address: w.address,
          route,
          status: "failed",
          reason: msg.length > 160 ? `${msg.slice(0, 157)}...` : msg,
          tokenSold: BigInt(0),
          solReceivedLamports: BigInt(0),
        };
      }
    });

  const settled = await Promise.allSettled(workers);
  const outcomes: SellOutcome[] = settled.map((r) => {
    if (r.status === "fulfilled") return r.value;
    const msg = r.reason instanceof Error ? r.reason.message : String(r.reason);
    return {
      address: "?",
      route,
      status: "failed",
      reason: msg,
      tokenSold: BigInt(0),
      solReceivedLamports: BigInt(0),
    };
  });

  const keyedCount = wallets.filter((w) => w.key).length;
  const skipped = outcomes.filter((o) => o.status === "skipped").length;
  const failed = outcomes.filter((o) => o.status === "failed").length;
  const sold = outcomes.filter((o) => o.status === "sold").length;

  let holderCountAfter: number | null = null;
  try {
    holderCountAfter = await holderCount(connection, mint);
  } catch {
    // holder read rate-limited on the public RPC; report null (the caller
    // falls back to the roster balances).
  }

  return {
    route,
    graduated,
    creator,
    poolKey: poolKey ? poolKey.toBase58() : null,
    total: wallets.length,
    skipped: skipped + Math.max(0, wallets.length - keyedCount),
    failed,
    sold,
    outcomes,
    holderCountAfter,
  };
}

/** Formats a lamports amount as a short SOL string (engine report helper,
 *  kept here so the UI and tests share one formatter). */
export function formatSolLamports(lamports: bigint): string {
  return `${(Number(lamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL`;
}
