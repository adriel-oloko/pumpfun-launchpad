// Milestone M5: the auto buy/sell engine (Feature 2).
//
// Port of v4-launchpad's auto engine to the pumpfun Solana client, with the
// exact agreed semantics:
//
//   - Auto BUY: on/off, wallet count, duration (seconds), MIN SOL. Each round
//     picks `count` RANDOM keyed wallets with a known SOL balance > 0 and
//     >= MIN SOL (below min = SKIP), and buys a % of the wallet's spendable
//     SOL balance (v4 default 95) from the curve via the program's buy
//     instruction. The spendable base is the live balance minus the
//     rent-exempt floor, the tx fee margin, and (on a wallet's very first buy
//     of this mint) the Token-2022 ATA rent, so a buy tx can never leave the
//     wallet below rent or fail for lack of ATA rent.
//   - Auto SELL: on/off, wallet count, duration, MIN %. Each round picks
//     `count` RANDOM keyed wallets with token balance > 0 and sells a % of
//     their OWN holdings (v4 default 100) via the program's sell instruction.
//     MIN % is a per-wallet dust gate measured against the token's TOTAL
//     SUPPLY: a wallet holding below (MIN % of total supply) is SKIPPED, so
//     the bot never burns rounds/txs dumping dust. MIN % = 0 or blank
//     disables the gate (v4 behavior: sell any wallet with a bag).
//   - Trade execution: each picked wallet's trade is its own signed tx (the
//     wallet is the fee payer), fired concurrently with Promise.allSettled,
//     reporting only the final completed count (the v4 batch pattern).
//
// The graduation guard lives in the scheduler (components/trade-panel.tsx):
// before each round it fetches the curve state and stops the bot when
// `graduated` is true. This module exposes the state read so both the Start
// validation and each tick use the same path.
//
// Round serialization (one shared autoLockRef) lives in the trade panel, not
// here: this module's fire functions are pure per-round workers.
//
// All amounts are bigint (no bigint literals, project target is ES2017).
// The anchor Program is used ONLY to encode instructions from the IDL and
// fetch accounts, exactly like the M4 launch flow (minimal provider; every
// tx is signed manually with the wallet's Keypair).

import { Program, BN } from "@coral-xyz/anchor";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import bs58 from "bs58";
import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  CURVE_SEED,
  MINT_AUTHORITY_SEED,
  RENT_EXEMPT_FLOOR,
  sendAndConfirmWithRetry,
  walletTokenBalance,
} from "./bundle/launch";
import { TOTAL_SUPPLY } from "./params";

/** % of a wallet's spendable SOL balance bought per auto-buy round (v4's
 *  buyPct default). Configurable knob; no UI field exists for it in the AUTO
 *  tab (v4 kept it on its manual tab, which this launchpad omits by spec). */
export const AUTO_BUY_PCT: number = 95;

/** % of a wallet's OWN token holdings sold per auto-sell round (v4's
 *  sellPct default). */
export const AUTO_SELL_PCT: number = 100;

/** Max seconds a per-wallet tx may take to confirm before the round counts
 *  it as failed (devnet confirmations are usually < 2s; this is generous). */
export const AUTO_CONFIRM_TIMEOUT_MS: number = 40_000;

/** Lamports reserved above the rent floor on a buy (covers the 5000-lamport
 *  base fee and a small margin). */
export const AUTO_TX_FEE_RESERVE_LAMPORTS: bigint = BigInt(10_000);

/** A live roster balance for the picker. Matches the shape useRoster keeps. */
export interface AutoWalletBalance {
  /** Lamports; null when the last read failed (keep it out of picks). */
  sol: bigint | null;
  /** Raw token units for the tracked mint; null when unknown. */
  token: bigint | null;
}

/** A keyed roster wallet eligible for a round. */
export interface AutoWallet {
  address: string;
  /** Base58 64-byte secret. Only keyed wallets are ever picked. */
  key: string;
}

/** Decoded curve state for the auto engine's gates. */
export interface AutoCurveInfo {
  /** Base58 creator pubkey; the buy instruction validates this against
   *  curve_state.creator and needs the creator's ATA for auto-graduation. */
  creator: string;
  /** True once the curve graduated; buy/sell revert and the bot stops. */
  graduated: boolean;
  solReserve: bigint;
  tokenReserve: bigint;
  supplyOut: bigint;
}

/** Fetch result that distinguishes "mint has no curve" from RPC errors. */
export type AutoCurveRead =
  | { kind: "ok"; curve: AutoCurveInfo }
  | { kind: "missing" };

/** Derives the two PDAs an existing mint's curve needs for trading. */
export function deriveAutoPdas(
  programId: PublicKey,
  mint: PublicKey
): { curveState: PublicKey; mintAuthority: PublicKey } {
  const [curveState] = PublicKey.findProgramAddressSync(
    [CURVE_SEED, mint.toBuffer()],
    programId
  );
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [MINT_AUTHORITY_SEED, mint.toBuffer()],
    programId
  );
  return { curveState, mintAuthority };
}

function normPubkey(v: unknown): string | null {
  if (v && typeof v === "object" && "toBase58" in v) {
    return (v as { toBase58: () => string }).toBase58();
  }
  return typeof v === "string" ? v : null;
}

function normBig(v: unknown): bigint {
  if (v === null || v === undefined) return BigInt(0);
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  if (typeof v === "object" && "toString" in v) {
    const s = (v as { toString: () => string }).toString();
    if (/^-?\d+$/.test(s)) return BigInt(s);
  }
  return BigInt(0);
}

function normBool(v: unknown): boolean {
  return v === true || v === 1;
}

/** Raw curve account shape returned by program.account.curveStateAccount
 *  (anchor decodes account fields to camelCase; a couple of defensive
 *  spellings are accepted through normalization). */
interface CurveAccountFetch {
  creator?: unknown;
  graduated?: unknown;
  solReserve?: unknown;
  tokenReserve?: unknown;
  supplyOut?: unknown;
}

/**
 * Fetches the curve state for a mint via the anchor account namespace.
 * Returns { kind: "missing" } when the curve account does not exist or does
 * not decode (e.g. a random mint with no curve behind the token address);
 * throws on transport/RPC errors so the caller can retry instead of treating
 * a transient failure as a dead curve.
 */
export async function readAutoCurveState(
  program: Program,
  mint: PublicKey
): Promise<AutoCurveRead> {
  const { curveState } = deriveAutoPdas(program.programId, mint);
  const account = (
    program.account as unknown as {
      curveStateAccount: {
        fetch: (key: PublicKey) => Promise<CurveAccountFetch>;
      };
    }
  ).curveStateAccount;
  let fetched: CurveAccountFetch;
  try {
    fetched = await account.fetch(curveState);
  } catch (e) {
    // Anchor throws AccountDoesNotExist / deserialization errors for a mint
    // with no curve; transport errors surface as fetch failures too, so
    // distinguish by probing the account directly.
    const info = await program.provider.connection.getAccountInfo(
      curveState,
      "confirmed"
    );
    if (!info) return { kind: "missing" };
    throw e;
  }
  const creator = normPubkey(fetched.creator);
  if (!creator) return { kind: "missing" };
  return {
    kind: "ok",
    curve: {
      creator,
      graduated: normBool(fetched.graduated),
      solReserve: normBig(fetched.solReserve),
      tokenReserve: normBig(fetched.tokenReserve),
      supplyOut: normBig(fetched.supplyOut),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Input parsing (v4 clamps, ETH -> SOL)                              */
/* ------------------------------------------------------------------ */

/** Wallet count: blank/invalid -> 1 (v4's clamp). */
export function clampAutoCount(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Duration seconds -> ms: blank/invalid -> 2000ms (v4's clamp). */
export function clampAutoDurationMs(raw: string): number {
  const n = Math.floor(Number(raw));
  return Number.isFinite(n) && n >= 1 ? n * 1000 : 2000;
}

/** MIN SOL input -> lamports; blank/invalid/zero -> 0n (no minimum). */
export function parseAutoMinSol(raw: string): bigint {
  const trimmed = raw.trim();
  if (!trimmed) return BigInt(0);
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return BigInt(0);
  return BigInt(Math.round(n * LAMPORTS_PER_SOL));
}

/** MIN % input (0-100, blank/invalid/<=0 -> 0 = gate disabled). */
export function parseAutoMinPct(raw: string): number {
  const trimmed = raw.trim();
  if (!trimmed) return 0;
  const n = Number(trimmed);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(100, n);
}

/** Raw token floor for the sell MIN % gate: MIN % of TOTAL_SUPPLY. A wallet
 *  holding below this is dust and is skipped. 0 when the gate is disabled. */
export function autoSellMinRaw(pct: number): bigint {
  if (!(pct > 0)) return BigInt(0);
  return (TOTAL_SUPPLY * BigInt(Math.round(pct * 100))) / BigInt(10_000);
}

/* ------------------------------------------------------------------ */
/* Balance-gated random picker (direction-aware, v4 semantics)        */
/* ------------------------------------------------------------------ */

/**
 * Randomly picks `count` keyed wallets that clear the side's balance gate:
 *   - 'sol'   (buy): known SOL balance > 0 and >= minSolLamports.
 *   - 'token' (sell): known token balance > 0 and >= minSellRaw (MIN % gate;
 *             minSellRaw = 0 disables it).
 * Wallets with no known balance (read failed / never polled) are treated as
 * unfunded and skipped, exactly like v4. A fresh draw every tick. There is
 * NO hub wallet in this launchpad (every roster wallet is a dev wallet), so
 * unlike v4 no first row is excluded.
 */
export function pickRandomKeyedWallets(
  count: number,
  side: "sol" | "token",
  wallets: { address: string; key?: string }[],
  balances: Map<string, AutoWalletBalance>,
  minSolLamports: bigint,
  minSellRaw: bigint
): AutoWallet[] {
  const pool: AutoWallet[] = [];
  for (const w of wallets) {
    if (!w.key) continue;
    const bal = balances.get(w.address);
    if (!bal) continue;
    if (side === "sol") {
      const sol = bal.sol;
      if (sol === null || sol <= BigInt(0)) continue;
      if (sol < minSolLamports) continue;
    } else {
      const tok = bal.token;
      if (tok === null || tok <= BigInt(0)) continue;
      if (tok < minSellRaw) continue;
    }
    pool.push({ address: w.address, key: w.key });
  }
  const n = Math.min(count, pool.length);
  // Fisher-Yates shuffle, then take the first n.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, n);
}

/* ------------------------------------------------------------------ */
/* Instruction builders (IDL-driven, mirror lib/bundle/launch.ts)     */
/* ------------------------------------------------------------------ */

/** One auto-buy instruction: buyer = the wallet, curve accounts resolved
 *  from the mint, creator accounts from the fetched curve state (validated
 *  on-chain on every buy; used if the fill buy auto-graduates). */
export async function buildAutoBuyIx(
  program: Program,
  buyer: PublicKey,
  mint: PublicKey,
  solInLamports: bigint,
  creator: PublicKey
): Promise<TransactionInstruction> {
  const { curveState, mintAuthority } = deriveAutoPdas(
    program.programId,
    mint
  );
  const buyerAta = await getAssociatedTokenAddress(
    mint,
    buyer,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const creatorAta = await getAssociatedTokenAddress(
    mint,
    creator,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  return program.methods
    .buy(new BN(solInLamports.toString()))
    .accounts({
      buyer,
      mint,
      curveState,
      buyerAta,
      creatorAccount: creator,
      creatorAta,
      mintAuthority,
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** One auto-sell instruction (6 accounts, no creator leg on sell). */
export async function buildAutoSellIx(
  program: Program,
  seller: PublicKey,
  mint: PublicKey,
  tokenIn: bigint
): Promise<TransactionInstruction> {
  const { curveState } = deriveAutoPdas(program.programId, mint);
  const sellerAta = await getAssociatedTokenAddress(
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

/* ------------------------------------------------------------------ */
/* Round execution: per-wallet signed txs, concurrent, count only      */
/* ------------------------------------------------------------------ */

/** Per-round outcome: only the final counts (the v4 batch pattern). */
export interface AutoRoundResult {
  completed: number;
  failed: number;
  skipped: number;
}

export interface FireAutoBuyOptions {
  connection: Connection;
  program: Program;
  mint: PublicKey;
  curve: AutoCurveInfo;
  wallets: AutoWallet[];
  /** % of the wallet's spendable SOL balance to buy (default 95). */
  buyPct?: number;
  /** MIN SOL gate enforced again on the LIVE balance at fire time. */
  minSolLamports: bigint;
}

/**
 * Fires one auto-buy round: every picked wallet buys `buyPct`% of its own
 * spendable SOL balance as its own signed tx, concurrently. The spendable
 * base keeps the rent-exempt floor, a fee margin, and (first buy of this
 * mint only) the ATA rent unspent, so the tx is always landable on tiny
 * devnet balances. Skipped = live balance under MIN SOL or nothing tradeable;
 * failed = build/send/confirm error. Completed = confirmed on-chain.
 */
export async function fireAutoBuy(
  opts: FireAutoBuyOptions
): Promise<AutoRoundResult> {
  const { connection, program, mint, curve, wallets, minSolLamports } = opts;
  const buyPct = opts.buyPct ?? AUTO_BUY_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0 };
  }
  const pctNum = Math.round(buyPct * 100);
  const creator = new PublicKey(curve.creator);
  const ataRent = await connection.getMinimumBalanceForRentExemption(
    170,
    "confirmed"
  );
  const latest = await connection.getLatestBlockhash("confirmed");

  const results = await Promise.allSettled(
    wallets.map(async (w): Promise<"ok" | "skipped"> => {
      const kp = Keypair.fromSecretKey(bs58.decode(w.key));
      const live = BigInt(
        await connection.getBalance(kp.publicKey, "confirmed")
      );
      // MIN SOL enforced on the live balance (a stale poll must not fire).
      if (live < minSolLamports) return "skipped";
      // Reserve the ATA rent only when the ATA account does not exist yet
      // (the wallet's first buy of this mint creates it on demand).
      const ata = await getAssociatedTokenAddress(
        mint,
        kp.publicKey,
        false,
        TOKEN_2022_PROGRAM_ID
      );
      const ataInfo = await connection.getAccountInfo(ata, "confirmed");
      const reserveAta = ataInfo ? BigInt(0) : BigInt(ataRent);
      const spendable =
        live -
        BigInt(RENT_EXEMPT_FLOOR) -
        AUTO_TX_FEE_RESERVE_LAMPORTS -
        reserveAta;
      if (spendable <= BigInt(0)) return "skipped";
      const solIn = (spendable * BigInt(pctNum)) / BigInt(10_000);
      if (solIn <= BigInt(0)) return "skipped";
      const ix = await buildAutoBuyIx(
        program,
        kp.publicKey,
        mint,
        solIn,
        creator
      );
      const tx = new Transaction({
        feePayer: kp.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      tx.add(ix);
      // M7a: send + confirm with an automatic fresh-blockhash retry when the
      // blockhash expires (an expired tx can never land, so re-sending is
      // safe). Confirm timeouts surface as failures (the tx may still land),
      // they are never silently re-fired, which could double a buy.
      await sendAndConfirmWithRetry(connection, tx, [kp], {
        attempts: 2,
        confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
        label: "auto buy",
      });
      return "ok";
    })
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === "ok") completed += 1;
    else if (r.status === "fulfilled") skipped += 1;
    else failed += 1;
  }
  return { completed, failed, skipped };
}

export interface FireAutoSellOptions {
  connection: Connection;
  program: Program;
  mint: PublicKey;
  wallets: AutoWallet[];
  /** % of each wallet's OWN holdings to sell (default 100). */
  sellPct?: number;
  /** MIN % dust gate (raw floor = pct of TOTAL_SUPPLY), re-checked on the
   *  live balance at fire time; 0 disables. */
  minSellRaw: bigint;
}

/**
 * Fires one auto-sell round: every picked wallet sells `sellPct`% of its OWN
 * token holdings as its own signed tx, concurrently. Skipped = live token
 * balance <= 0 or below the MIN % floor; failed = build/send/confirm error.
 */
export async function fireAutoSell(
  opts: FireAutoSellOptions
): Promise<AutoRoundResult> {
  const { connection, program, mint, wallets, minSellRaw } = opts;
  const sellPct = opts.sellPct ?? AUTO_SELL_PCT;
  if (wallets.length === 0) {
    return { completed: 0, failed: 0, skipped: 0 };
  }
  const pctNum = Math.round(sellPct * 100);
  const latest = await connection.getLatestBlockhash("confirmed");

  const results = await Promise.allSettled(
    wallets.map(async (w): Promise<"ok" | "skipped"> => {
      const kp = Keypair.fromSecretKey(bs58.decode(w.key));
      const balance = await walletTokenBalance(
        connection,
        kp.publicKey,
        mint
      );
      if (balance <= BigInt(0)) return "skipped";
      if (balance < minSellRaw) return "skipped";
      const tokenIn = (balance * BigInt(pctNum)) / BigInt(10_000);
      if (tokenIn <= BigInt(0)) return "skipped";
      const ix = await buildAutoSellIx(program, kp.publicKey, mint, tokenIn);
      const tx = new Transaction({
        feePayer: kp.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: latest.lastValidBlockHeight,
      });
      tx.add(ix);
      // M7a: expiry-safe send + confirm, same semantics as the buy worker.
      await sendAndConfirmWithRetry(connection, tx, [kp], {
        attempts: 2,
        confirmTimeoutMs: AUTO_CONFIRM_TIMEOUT_MS,
        label: "auto sell",
      });
      return "ok";
    })
  );

  let completed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === "ok") completed += 1;
    else if (r.status === "fulfilled") skipped += 1;
    else failed += 1;
  }
  return { completed, failed, skipped };
}
