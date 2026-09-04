// Milestone M2 + M10: multi-wallet atomic launch construction on pump.fun's
// NATIVE program.
//
// This module builds the launch sequence:
//
//   [optional fund tx] -> [create tx] -> [buy tx 1] -> [buy tx 2] -> ...
//
// - The create transaction is signed by the creator AND the fresh mint
//   Keypair (pump.fun mints are generated client-side at launch, NOT PDAs;
//   the mint keypair must never be lost mid-launch — it stays in the same
//   signer set as the creator).
// - pump.fun's buy takes TOKENS OUT (+ max_sol_cost), so each wallet's SOL
//   amount is quoted client-side against the VIRTUAL reserves (constant
//   product + 1% fee + slippage headroom) before the txs are packed. The
//   curve starts at the known initial reserves (30 SOL / 1.073B virtual),
//   so pre-fill buys quote against the initial state, then each subsequent
//   buy quotes against the state the preceding fills leave behind.
// - Every buy instruction is built by hand (lib/pump.ts) over pump.fun's
//   program; the LEGACY SPL token program is used for the mint's ATAs
//   (pump.fun mints are NOT Token-2022). No anchor Program, no IDL.
// - Each buy tx packs as many dev-wallet buys as fit the 1232-byte
//   transaction limit. Measured (M10): one buy = an ATA-create-idempotent
//   ix + a 16-account buy ix ≈ 200 bytes/wallet, so 2 wallets fit a buy tx
//   (1060 signed bytes under the default 1150 - 90 tip budget); 3 overflow.
//   Every selected dev wallet signs its own buy; the creator signs each buy
//   tx as fee payer only. The tip-carrying last bundle tx holds <= 2.
// - The sequence can be sent as normal transactions (Tier 1, no Jito) or
//   assembled into a Jito bundle (Tier 2, see jito.ts).
//
// The curve economics are identical to the old custom program (30 SOL
// virtual reserve, 1.073B virtual token reserve, 1% fee, 85 SOL graduation,
// 6 decimals, 1e9 supply — lib/params.ts, unchanged).

import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import {
  PUMP_METAPLEX_PROGRAM_ID,
  buildPumpBuyIx,
  buildPumpCreateIx,
  pumpBondingCurvePda,
  pumpMetadataPda,
  pumpMintAuthorityPda,
  quotePumpBuy,
} from "../pump";
import { VIRTUAL_SOL_RESERVE, VIRTUAL_TOKEN_RESERVE } from "../params";
import { DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS } from "../fees";
import { isBlockhashExpiredError } from "../tx-errors";

/** Metaplex token metadata program id (pump.fun's create metadata PDA is
 *  derived under it). */
export const METAPLEX_PROGRAM_ID: PublicKey = PUMP_METAPLEX_PROGRAM_ID;

/** Hard Solana limits (lamport-free, spec constants). */
export const MAX_TX_BYTES = 1232;
export const MAX_COMPUTE_UNITS = 1_400_000;

/** Default serialized-byte budget for a buy tx. The tip transfer added to the
 *  last bundle tx costs ~80 bytes, so the last tx is packed to
 *  maxBuyTxBytes - tipReserveBytes and holds one wallet fewer. */
export const DEFAULT_MAX_BUY_TX_BYTES = 1150;
export const DEFAULT_TIP_RESERVE_BYTES = 90;

/** Rent-exempt floor for a native (data-less) account, lamports. Measured on
 *  devnet: a writable wallet that ends a buy below this is rejected with
 *  InsufficientFundsForRent even though the instruction itself succeeds. This
 *  is the rent formula's account-overhead charge (0 data + 128-byte storage
 *  overhead), the well-known 890,880 lamport floor. */
export const RENT_EXEMPT_FLOOR = 890_880;

/** All derived addresses for one launch (pump.fun derivations: the mint is a
 *  fresh Keypair; curveState is the pump "bonding-curve" PDA; mintAuthority
 *  is the GLOBAL pump mint-authority PDA; metadata is the mpl metadata PDA). */
export interface LaunchPdas {
  mint: PublicKey;
  curveState: PublicKey;
  mintAuthority: PublicKey;
  metadata: PublicKey;
}

/** One dev wallet's buy. */
export interface BuyAllocation {
  wallet: Keypair;
  /** SOL in lamports this wallet sends into the curve. */
  solInLamports: bigint;
}

/** One packed buy transaction (unsigned until signed). */
export interface BuyTx {
  tx: Transaction;
  /** The dev wallets whose buy instructions are packed here (each signs). */
  wallets: Keypair[];
  /** The buy instructions in order (flat; aligned with `walletIxs`). */
  instructions: TransactionInstruction[];
  /** Per-wallet instruction groups (each wallet's buy = an ATA-create
   *  idempotent ix + the pump.fun buy ix). */
  walletIxs: TransactionInstruction[][];
  /** Serialized byte size once signed (measured at pack time). */
  signedSize: number;
}

/** The complete launch sequence, all txs sharing one recent blockhash. */
export interface LaunchSequence {
  pda: LaunchPdas;
  /** The fresh mint keypair; signs the create tx alongside the creator and
   *  is NEVER lost mid-launch (it is part of signersByTx[create]). */
  mintKeypair: Keypair;
  creator: Keypair;
  name: string;
  symbol: string;
  uri: string;
  /** Creator -> wallet funding transfers (optional). */
  fundTx: Transaction | null;
  fundIx: TransactionInstruction[] | null;
  /** Funding transfers aligned 1:1 with `buys` (for sandbox pre-flights). */
  fundIxPerWallet: TransactionInstruction[] | null;
  createIx: TransactionInstruction;
  createTx: Transaction;
  buyTxs: BuyTx[];
  blockhash: { blockhash: string; lastValidBlockHeight: number };
  /** Signers per tx, aligned with [fund?, create, ...buyTxs]. */
  signersByTx: Keypair[][];
}

export interface BuildLaunchOptions {
  connection: Connection;
  /** Creator: signs create (with the mint keypair), is fee payer on every
   *  tx, pays funding. */
  creator: Keypair;
  name: string;
  symbol: string;
  uri: string;
  /** The selected dev wallets and their buy amounts. */
  buys: BuyAllocation[];
  /** Optional: lamports each wallet receives from the creator (funding tx).
   *  A single value applies to every wallet; an array applies per wallet. */
  fundLamportsPerWallet?: bigint | bigint[] | null;
  /** Byte budget per buy tx (default 1150; measured: 2 wallets = 1060). */
  maxBuyTxBytes?: number;
  /** Bytes reserved in the last buy tx for the bundle tip transfer. */
  tipReserveBytes?: number;
  /** Compute-unit limit instruction added to every buy tx. */
  computeUnitLimit?: number;
  /** Optional priority fee in micro-lamports per CU on every buy tx. */
  priorityFeeMicroLamports?: number;
  /** Slippage headroom (basis points) on every pre-fill buy's max_sol_cost
   *  quote (default 10%: covers reserve drift + the fee-program split). */
  slippageBps?: bigint;
}

/** Derives every pump.fun address for one launch from the fresh mint
 *  keypair (the mint is NOT a PDA anymore; the custom-program nonce/mint
 *  seeds are gone). */
export function deriveLaunchPdas(mint: PublicKey): LaunchPdas {
  const [curveState] = pumpBondingCurvePda(mint);
  const [mintAuthority] = pumpMintAuthorityPda();
  const [metadata] = pumpMetadataPda(mint);
  return { mint, curveState, mintAuthority, metadata };
}

/**
 * Quotes every pre-fill buy against the curve's INITIAL virtual reserves
 * (30 SOL / 1.073B — the state right after create, before any buy can land
 * on a fresh mint), chaining each fill's simulated reserve movement into the
 * next quote. Returns the per-wallet pump.fun buy args aligned 1:1 with
 * `buys`.
 */
export function quoteLaunchBuys(
  buys: BuyAllocation[],
  slippageBps?: bigint
): { tokensOut: bigint; maxSolCost: bigint }[] {
  let vsr = VIRTUAL_SOL_RESERVE;
  let vtr = VIRTUAL_TOKEN_RESERVE;
  const quotes: { tokensOut: bigint; maxSolCost: bigint }[] = [];
  for (const buy of buys) {
    const q = quotePumpBuy({
      solInLamports: buy.solInLamports,
      virtualSolReserves: vsr,
      virtualTokenReserves: vtr,
      slippageBps,
    });
    vsr = q.nextVirtualSolReserves;
    vtr = q.nextVirtualTokenReserves;
    quotes.push({ tokensOut: q.tokensOut, maxSolCost: q.maxSolCost });
  }
  return quotes;
}

/** Serialized size of a signed tx built from ixs + signers. */
function signedSize(
  creator: Keypair,
  ixs: TransactionInstruction[],
  wallets: Keypair[],
  blockhash: string,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number
): number {
  const tx = new Transaction({ feePayer: creator.publicKey, blockhash, lastValidBlockHeight: 0 });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  if (priorityFeeMicroLamports > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      })
    );
  }
  tx.add(...ixs);
  tx.sign(creator, ...wallets);
  try {
    return tx.serialize().length;
  } catch {
    // Transaction.serialize throws past the 1232-byte hard limit; a tx that
    // cannot serialize is by definition over the byte budget.
    return MAX_TX_BYTES + 1;
  }
}

/** Materializes one packed buy tx (unsigned). */
function materializeBuyTx(
  creator: Keypair,
  walletIxs: TransactionInstruction[][],
  wallets: Keypair[],
  blockhash: string,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number,
  signedSizeBytes: number
): BuyTx {
  const instructions = walletIxs.flat();
  const tx = new Transaction({
    feePayer: creator.publicKey,
    blockhash,
    lastValidBlockHeight: 0,
  });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  if (priorityFeeMicroLamports > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      })
    );
  }
  tx.add(...instructions);
  return { tx, wallets, instructions, walletIxs, signedSize: signedSizeBytes };
}

/**
 * Greedily packs the dev buys into buy transactions under the byte budget.
 * Each wallet's buy is two instructions (ATA-create idempotent + pump.fun
 * buy); the wallets sign their own buys and the creator signs as fee payer.
 * Measured (M10): ~200 bytes/wallet, 2 wallets max per tx (1060 bytes), 3
 * overflow the 1232-byte limit.
 */
export function packBuyTxs(opts: {
  creator: Keypair;
  pda: LaunchPdas;
  buys: BuyAllocation[];
  quotes: { tokensOut: bigint; maxSolCost: bigint }[];
  blockhash: string;
  maxBuyTxBytes?: number;
  tipReserveBytes?: number;
  computeUnitLimit?: number;
  priorityFeeMicroLamports?: number;
}): BuyTx[] {
  const {
    creator,
    pda,
    buys,
    quotes,
    blockhash,
    maxBuyTxBytes = DEFAULT_MAX_BUY_TX_BYTES,
    tipReserveBytes = DEFAULT_TIP_RESERVE_BYTES,
    computeUnitLimit = MAX_COMPUTE_UNITS,
    priorityFeeMicroLamports = DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  } = opts;
  if (maxBuyTxBytes > MAX_TX_BYTES) {
    throw new Error(`maxBuyTxBytes ${maxBuyTxBytes} > hard limit ${MAX_TX_BYTES}`);
  }
  if (quotes.length !== buys.length) {
    throw new Error(`quotes (${quotes.length}) must align with buys (${buys.length})`);
  }
  const budget = maxBuyTxBytes - tipReserveBytes;

  const out: BuyTx[] = [];
  let current: { wallets: Keypair[]; walletIxs: TransactionInstruction[][] } | null = null;
  let currentSize = 0;

  for (let i = 0; i < buys.length; i++) {
    const buy = buys[i];
    const quote = quotes[i];
    const ixs = buildPumpBuyIx({
      mint: pda.mint,
      buyer: buy.wallet.publicKey,
      creator: creator.publicKey,
      tokensOut: quote.tokensOut,
      maxSolCost: quote.maxSolCost,
    });
    if (!current) current = { wallets: [], walletIxs: [] };
    const candidate: { wallets: Keypair[]; walletIxs: TransactionInstruction[][] } = {
      wallets: [...current.wallets, buy.wallet],
      walletIxs: [...current.walletIxs, ixs],
    };
    const size = signedSize(
      creator,
      candidate.walletIxs.flat(),
      candidate.wallets,
      blockhash,
      computeUnitLimit,
      priorityFeeMicroLamports
    );
    if (current.wallets.length === 0 || size <= budget) {
      current = candidate;
      currentSize = size;
    } else {
      // the candidate would overflow the budget: close the current tx
      out.push(
        materializeBuyTx(
          creator,
          current.walletIxs,
          current.wallets,
          blockhash,
          computeUnitLimit,
          priorityFeeMicroLamports,
          currentSize
        )
      );
      current = { wallets: [buy.wallet], walletIxs: [ixs] };
      currentSize = signedSize(
        creator,
        ixs,
        [buy.wallet],
        blockhash,
        computeUnitLimit,
        priorityFeeMicroLamports
      );
    }
  }
  if (current && current.wallets.length > 0) {
    out.push(
      materializeBuyTx(
        creator,
        current.walletIxs,
        current.wallets,
        blockhash,
        computeUnitLimit,
        priorityFeeMicroLamports,
        currentSize
      )
    );
  }
  return out;
}

/**
 * Builds the full launch sequence: a fresh mint Keypair, the pump.fun create
 * tx (signed by the creator + the mint keypair) and every pre-fill buy tx
 * quoted client-side against the chained virtual reserves. All txs share one
 * recent blockhash so the same signed txs can either be sent sequentially
 * (Tier 1) or packed into a single Jito bundle with the same blockhash
 * (Tier 2).
 */
export async function buildLaunchSequence(
  opts: BuildLaunchOptions
): Promise<LaunchSequence> {
  const {
    connection,
    creator,
    name,
    symbol,
    uri,
    buys,
    fundLamportsPerWallet = null,
    maxBuyTxBytes,
    tipReserveBytes,
    computeUnitLimit,
    priorityFeeMicroLamports,
    slippageBps,
  } = opts;
  if (buys.length === 0) throw new Error("at least one dev wallet buy is required");

  // M7a fee policy: resolve the knobs once so the create tx, the fund tx and
  // every packed buy tx carry the SAME compute-unit price. When the caller
  // omits them the lib/fees.ts defaults apply (env-tunable). The CU-limit ix
  // goes on every tx so the price ix (which requires the limit ix to precede
  // it in the same tx) is always well-formed.
  const cuLimit = computeUnitLimit ?? MAX_COMPUTE_UNITS;
  const priorityFee = priorityFeeMicroLamports ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  const addFeeIxs = (tx: Transaction): void => {
    tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    if (priorityFee > 0) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFee,
        })
      );
    }
  };

  // M10: the mint is a FRESH Keypair generated client-side (never a PDA, and
  // never lost: it signs the create tx in signersByTx[create]).
  const mintKeypair = Keypair.generate();
  const pda = deriveLaunchPdas(mintKeypair.publicKey);
  const latest = await connection.getLatestBlockhash("confirmed");
  const blockhash = { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };

  const createIx = buildPumpCreateIx({
    creator: creator.publicKey,
    mint: mintKeypair.publicKey,
    name,
    symbol,
    uri,
  });
  const createTx = new Transaction({ feePayer: creator.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: 0 });
  addFeeIxs(createTx);
  createTx.add(createIx);

  let fundTx: Transaction | null = null;
  let fundIx: TransactionInstruction[] | null = null;
  let fundIxPerWallet: TransactionInstruction[] | null = null;
  if (fundLamportsPerWallet !== null && fundLamportsPerWallet !== undefined) {
    const amounts = Array.isArray(fundLamportsPerWallet)
      ? fundLamportsPerWallet
      : buys.map(() => fundLamportsPerWallet);
    if (amounts.length !== buys.length) {
      throw new Error(
        `fundLamportsPerWallet has ${amounts.length} amounts but ${buys.length} wallets`
      );
    }
    if (amounts.some((a) => a > BigInt(0))) {
      fundIxPerWallet = buys.map((b, i) =>
        SystemProgram.transfer({
          fromPubkey: creator.publicKey,
          toPubkey: b.wallet.publicKey,
          lamports: Number(amounts[i]),
        })
      );
      fundIx = [...fundIxPerWallet];
      fundTx = new Transaction({ feePayer: creator.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: 0 });
      addFeeIxs(fundTx);
      fundTx.add(...fundIx);
    }
  }

  // M10: client-side quotes (pump.fun buy takes tokens_out + max_sol_cost,
  // so the SOL->tokens math happens here, chained across the fills).
  const quotes = quoteLaunchBuys(buys, slippageBps);

  const buyTxs = packBuyTxs({
    creator,
    pda,
    buys,
    quotes,
    blockhash: latest.blockhash,
    maxBuyTxBytes,
    tipReserveBytes,
    computeUnitLimit: cuLimit,
    priorityFeeMicroLamports: priorityFee,
  });

  const signersByTx: Keypair[][] = [];
  if (fundTx) signersByTx.push([creator]);
  signersByTx.push([creator, mintKeypair]);
  for (const bt of buyTxs) signersByTx.push([creator, ...bt.wallets]);

  return {
    pda,
    mintKeypair,
    creator,
    name,
    symbol,
    uri,
    fundTx,
    fundIx,
    fundIxPerWallet,
    createIx,
    createTx,
    buyTxs,
    blockhash,
    signersByTx,
  };
}

/** Sets a fresh recent blockhash on a tx (re-signing happens later). */
export function setBlockhash(
  tx: Transaction,
  blockhash: string,
  lastValidBlockHeight: number
): void {
  tx.recentBlockhash = blockhash;
  tx.lastValidBlockHeight = lastValidBlockHeight;
}

/** Signs one tx with its signers, returning the signed tx. */
export function signTx(tx: Transaction, signers: Keypair[]): Transaction {
  tx.sign(...signers);
  return tx;
}

/** The [fund?, create, ...buys] tx list in execution order. */
export function sequenceTxs(seq: LaunchSequence): Transaction[] {
  const txs: Transaction[] = [];
  if (seq.fundTx) txs.push(seq.fundTx);
  txs.push(seq.createTx);
  for (const bt of seq.buyTxs) txs.push(bt.tx);
  return txs;
}

export interface SimResult {
  err: unknown;
  unitsConsumed: number | null;
  logs: string[] | null;
}

/** Simulates one tx against the live chain (resigning with `signers`). */
export async function simulateTx(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[]
): Promise<SimResult> {
  const r = await connection.simulateTransaction(tx, signers);
  return {
    err: r.value.err ?? null,
    unitsConsumed: r.value.unitsConsumed ?? null,
    logs: r.value.logs ?? null,
  };
}

/** Builds a versioned (V0) sandbox tx for pre-flight simulation. The
 *  create+buy sandbox exceeds the 1232-byte legacy limit (the upgraded
 *  pump.fun instructions are bigger); the ALT shrinks the constant accounts
 *  to 1-byte indexes so the same sandbox (CU-limit ix KEPT) fits. */
export function buildSandboxV0(opts: {
  payerKey: PublicKey;
  recentBlockhash: string;
  instructions: TransactionInstruction[];
  lookupTable: AddressLookupTableAccount;
  signers: Keypair[];
}): VersionedTransaction {
  const message = new TransactionMessage({
    payerKey: opts.payerKey,
    recentBlockhash: opts.recentBlockhash,
    instructions: opts.instructions,
  }).compileToV0Message([opts.lookupTable]);
  const v0 = new VersionedTransaction(message);
  v0.sign(opts.signers);
  return v0;
}

/**
 * Pre-flight simulation of the whole launch. The create tx simulates
 * standalone against the live chain (signed by the creator + the mint
 * keypair). Buy txs cannot simulate standalone on a fresh mint (the curve
 * does not exist yet), so each wallet's buy is validated in a sandbox tx
 * that runs the funding transfer + the create instruction first. The
 * create+buy sandbox overflows the 1232-byte legacy limit, so when an
 * address lookup table is supplied each sandbox is built as a V0 tx (see
 * buildSandboxV0). A failed simulation is a hard error.
 */
export async function preflightLaunch(
  connection: Connection,
  seq: LaunchSequence,
  lookupTable?: AddressLookupTableAccount
): Promise<{
  create: SimResult;
  buyChunks: { buyTxIndex: number; walletCount: number; result: SimResult }[];
}> {
  const latest = await connection.getLatestBlockhash("confirmed");

  // 1) create tx standalone, preceded by up to two funding transfers (the
  //    sandbox must stay under the 1232-byte limit even for large rosters;
  //    each buy sandbox below funds its own wallet, so a full funding sweep
  //    is never needed here).
  const createTx = new Transaction({
    feePayer: seq.creator.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: 0,
  });
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }));
  if (seq.fundIx) createTx.add(...seq.fundIx.slice(0, 2));
  createTx.add(seq.createIx);
  const create = await simulateTx(connection, createTx, [
    seq.creator,
    seq.mintKeypair,
  ]);
  if (create.err) {
    throw new Error(`preflight: create simulation failed: ${JSON.stringify(create.err)}`);
  }

  // 2) each buy tx's wallets, sandboxed one at a time behind fund + create.
  const buyChunks: { buyTxIndex: number; walletCount: number; result: SimResult }[] = [];
  let walletOffset = 0;
  for (let i = 0; i < seq.buyTxs.length; i++) {
    const bt = seq.buyTxs[i];
    for (let w = 0; w < bt.wallets.length; w++) {
      const wallet = bt.wallets[w];
      const walletIxs = bt.walletIxs[w];
      const chunkFundIx = seq.fundIxPerWallet
        ? [seq.fundIxPerWallet[walletOffset + w]]
        : [];
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
        ...chunkFundIx,
        seq.createIx,
        ...walletIxs,
      ];
      let result: SimResult;
      if (lookupTable) {
        const v0 = buildSandboxV0({
          payerKey: seq.creator.publicKey,
          recentBlockhash: latest.blockhash,
          instructions,
          lookupTable,
          signers: [seq.creator, seq.mintKeypair, wallet],
        });
        const r = await connection.simulateTransaction(v0);
        result = {
          err: r.value.err ?? null,
          unitsConsumed: r.value.unitsConsumed ?? null,
          logs: r.value.logs ?? null,
        };
      } else {
        const tx = new Transaction({
          feePayer: seq.creator.publicKey,
          blockhash: latest.blockhash,
          lastValidBlockHeight: 0,
        });
        tx.add(...instructions);
        result = await simulateTx(connection, tx, [
          seq.creator,
          seq.mintKeypair,
          wallet,
        ]);
      }
      if (result.err) {
        throw new Error(
          `preflight: buy tx ${i} wallet ${w} simulation failed: ${JSON.stringify(result.err)}`
        );
      }
      buyChunks.push({ buyTxIndex: i, walletCount: 1, result });
    }
    walletOffset += bt.wallets.length;
  }
  return { create, buyChunks };
}

/** Local error-message extractor. */
function errMsgOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Small delay helper for retry pacing. */
function sleepMs(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** One send + confirm cycle that retries ONLY on a stale/expired blockhash.
 *  An expired tx can never land, so re-sending it with a fresh blockhash is
 *  safe and cannot double-execute. A confirmation TIMEOUT is surfaced, not
 *  silently retried, because a timed-out tx may still land and retrying it
 *  blindly could double a buy/sell. An on-chain revert is deterministic and
 *  is thrown immediately. Every attempt re-signs over a fresh blockhash
 *  (old signatures are cleared first). Never hangs: each attempt's confirm
 *  is bounded by withTimeout. */
export async function sendAndConfirmWithRetry(
  connection: Connection,
  tx: Transaction,
  signers: Keypair[],
  opts: { attempts?: number; confirmTimeoutMs?: number; label?: string } = {}
): Promise<{ signature: string }> {
  const attempts = opts.attempts ?? 3;
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 45_000;
  const label = opts.label ?? "tx";
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    const latest = await connection.getLatestBlockhash("confirmed");
    setBlockhash(tx, latest.blockhash, latest.lastValidBlockHeight);
    // Clear stale signatures: a previous attempt signed over an older
    // message (old blockhash). Re-signing must start from an empty set.
    tx.signatures = [];
    signTx(tx, signers);
    let signature: string;
    try {
      signature = await connection.sendRawTransaction(tx.serialize());
    } catch (e) {
      lastErr = e;
      if (isBlockhashExpiredError(errMsgOf(e)) && attempt + 1 < attempts) {
        await sleepMs(400);
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
    try {
      const confirmed = await withTimeout(
        connection.confirmTransaction(
          {
            signature,
            blockhash: latest.blockhash,
            lastValidBlockHeight: latest.lastValidBlockHeight,
          },
          "confirmed"
        ),
        confirmTimeoutMs,
        `${label} (${signature}) confirm timed out after ${confirmTimeoutMs}ms; the tx may still land`
      );
      if (confirmed.value.err) {
        throw new Error(
          `${label} (${signature}) failed on chain: ${JSON.stringify(confirmed.value.err)}`
        );
      }
      return { signature };
    } catch (e) {
      lastErr = e;
      const msg = errMsgOf(e);
      if (isBlockhashExpiredError(msg) && attempt + 1 < attempts) {
        await sleepMs(400);
        continue;
      }
      throw e instanceof Error ? e : new Error(String(e));
    }
  }
  throw lastErr instanceof Error
    ? lastErr
    : new Error(`${label} failed after ${attempts} send attempts`);
}

/** Sends the sequence as normal transactions, confirming each (Tier 1).
 *  Each tx is sent with sendAndConfirmWithRetry: a stale/expired blockhash is
 *  retried with a fresh one (up to 3 attempts), never a bare failure or a
 *  hang. A mid-sequence failure throws with the partial-state context: the
 *  txs that already confirmed are named so the caller never mistakes a
 *  partial launch for a no-op. */
export async function sendSequentially(
  connection: Connection,
  seq: LaunchSequence,
  opts: { confirmTimeoutMs?: number; onSignature?: (label: string, sig: string) => void } = {}
): Promise<{ label: string; signature: string }[]> {
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 45_000;
  const txs = sequenceTxs(seq);
  const labels: string[] = [];
  if (seq.fundTx) labels.push("fund");
  labels.push("create");
  for (let i = 0; i < seq.buyTxs.length; i++) labels.push(`buy${i + 1}`);

  const sent: { label: string; signature: string }[] = [];
  for (let i = 0; i < txs.length; i++) {
    const label = labels[i];
    try {
      const { signature } = await sendAndConfirmWithRetry(connection, txs[i], seq.signersByTx[i], {
        attempts: 3,
        confirmTimeoutMs,
        label: `tx ${label}`,
      });
      if (opts.onSignature) opts.onSignature(label, signature);
      sent.push({ label, signature });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const partial =
        sent.length > 0
          ? ` NOTE: ${sent.length} earlier launch tx(s) already confirmed (${sent
              .map((s) => s.label)
              .join(", ")}); the token may be partially launched. A fresh launch creates a NEW mint; do not re-send this sequence.`
          : "";
      throw new Error(`${msg}${partial}`);
    }
  }
  return sent;
}

/** Promise.race with a timeout that rejects (never hangs). */
export async function withTimeout<T>(p: Promise<T>, ms: number, msg: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(msg)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    clearTimeout(timer!);
  }
}

/** Reads a wallet's legacy-SPL token balance for the launch mint (raw
 *  units). pump.fun mints are LEGACY SPL tokens, so the ATA is derived with
 *  TOKEN_PROGRAM_ID (never Token-2022). */
export async function walletTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_PROGRAM_ID);
  try {
    const r = await connection.getTokenAccountBalance(ata, "confirmed");
    return BigInt(r.value.amount);
  } catch {
    return BigInt(0);
  }
}

/** Counts holders via getTokenLargestAccounts (single attempt; the public
 *  devnet RPC rate-limits this call, so callers should fall back to the known
 *  wallet roster on failure). */
export async function holderCount(connection: Connection, mint: PublicKey): Promise<number> {
  const r = await connection.getTokenLargestAccounts(mint, "confirmed");
  return r.value.filter((a) => BigInt(a.amount) > BigInt(0)).length;
}

/** Lamports needed by each wallet to create its legacy-SPL ATA on first buy.
 *  Legacy SPL token accounts are 165 bytes (the Token-2022 170-byte size
 *  that the old custom program used is gone). */
export async function ataRentLamports(connection: Connection): Promise<number> {
  return connection.getMinimumBalanceForRentExemption(165, "confirmed");
}

/** Lamports a wallet must retain after its buy: the rent-exempt floor for a
 *  native account plus a margin, or the runtime rejects the tx. */
export function postBuyFloorLamports(): bigint {
  return BigInt(RENT_EXEMPT_FLOOR + 10_000);
}

/**
 * Reads and decodes the token name / symbol / uri from a Metaplex metadata
 * account (mpl-token-metadata on-chain layout). Layout after the 1-byte key
 * + 32-byte update authority + 32-byte mint:
 *   u32 LE name_len + name, u32 LE symbol_len + symbol, u32 LE uri_len + uri.
 * Returns null when the account does not exist or cannot be decoded (e.g.
 * the metadata PDA was never created). Used by the launch panel and the
 * verify script to confirm the on-chain metadata after a launch.
 */
export async function readMetadataStrings(
  connection: Connection,
  metadataPda: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  const info = await connection.getAccountInfo(metadataPda, "confirmed");
  if (!info) return null;
  const data = info.data;
  // header: key(1) + update_authority(32) + mint(32)
  if (data.length < 65) return null;
  let offset = 65;
  const readLenPrefixed = (): string | null => {
    if (offset + 4 > data.length) return null;
    const len = data.readUInt32LE(offset);
    offset += 4;
    if (offset + len > data.length) return null;
    const s = data.subarray(offset, offset + len).toString("utf8");
    offset += len;
    return s;
  };
  const name = readLenPrefixed();
  const symbol = readLenPrefixed();
  const uri = readLenPrefixed();
  if (name === null || symbol === null || uri === null) return null;
  return { name, symbol, uri };
}

export { LAMPORTS_PER_SOL };
