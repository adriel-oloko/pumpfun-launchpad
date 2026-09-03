// Milestone M2: multi-wallet atomic launch construction.
//
// This module builds the launch sequence for the M1 pumpfun program:
//
//   [optional fund tx] -> [create tx] -> [buy tx 1] -> [buy tx 2] -> ...
//
// - The create transaction is signed by the creator only.
// - Each buy transaction packs as many dev-wallet buys as fit the 1232-byte
//   transaction limit (measured: ~155 bytes per extra wallet, so 5 wallets per
//   buy tx is the byte ceiling; the tip-carrying last bundle tx holds 4).
//   Every selected dev wallet signs its own buy; the creator signs each buy tx
//   as fee payer only.
// - First buys create each wallet's Token-2022 ATA on demand (rent 0.001887
//   SOL, 170 bytes, paid by the buyer). Measured devnet CU: ~33-37k per buy
//   with ATA creation, ~72k for create, so 5 buys in one tx is ~185k CU, far
//   under the 1.4M ceiling: bytes are the binding constraint, not compute.
// - The sequence can be sent as normal transactions (Tier 1, no Jito) or
//   assembled into a Jito bundle (Tier 2, see jito.ts).
//
// The anchor client is consumed exactly as verified against
// target/idl/pumpfun.json: program.methods.buy|create with the IDL account
// names, .instruction() emits the 8-byte discriminator + borsh args and the
// IDL account order. No account list is hardcoded anywhere.

import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Buffer } from "buffer";
import { BN, Program } from "@coral-xyz/anchor";
import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  SYSVAR_INSTRUCTIONS_PUBKEY,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import { DEFAULT_AUTO_MIGRATE, DEFAULT_LOCK_LP } from "../params";
import { DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS } from "../fees";
import { isBlockhashExpiredError } from "../tx-errors";

/** Metaplex token metadata program id (from target/idl/pumpfun.json). */
export const METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

/** PDA seed prefixes, replicated exactly from programs/pumpfun/src/lib.rs. */
export const MINT_SEED = Buffer.from("mint");
export const CURVE_SEED = Buffer.from("curve");
export const MINT_AUTHORITY_SEED = Buffer.from("mint_authority");
export const METADATA_SEED = Buffer.from("metadata");

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

/** All derived addresses for one launch. */
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
  /** The buy instructions in order. */
  instructions: TransactionInstruction[];
  /** Serialized byte size once signed (measured at pack time). */
  signedSize: number;
}

/** The complete launch sequence, all txs sharing one recent blockhash. */
export interface LaunchSequence {
  pda: LaunchPdas;
  creator: Keypair;
  nonce: bigint;
  name: string;
  symbol: string;
  uri: string;
  /** Whether create() actually carried the auto_migrate / lock_lp args (true
   *  only when the loaded IDL exposes them). When false the M3 flags were
   *  NOT sent, never silently: the caller sees this and can surface the
   *  pre-upgrade note. */
  migrationArgsSupported: boolean;
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
  program: Program;
  connection: Connection;
  /** Creator: signs create, is fee payer on every tx, pays funding. */
  creator: Keypair;
  nonce: bigint;
  name: string;
  symbol: string;
  uri: string;
  /** The selected dev wallets and their buy amounts. */
  buys: BuyAllocation[];
  /** Optional: lamports each wallet receives from the creator (funding tx).
   *  A single value applies to every wallet; an array applies per wallet. */
  fundLamportsPerWallet?: bigint | bigint[] | null;
  /** Byte budget per buy tx (default 1150; 5 wallets = 1173, so 4 fit). */
  maxBuyTxBytes?: number;
  /** Bytes reserved in the last buy tx for the bundle tip transfer. */
  tipReserveBytes?: number;
  /** Compute-unit limit instruction added to every buy tx. */
  computeUnitLimit?: number;
  /** Optional priority fee in micro-lamports per CU on every buy tx. */
  priorityFeeMicroLamports?: number;
  /** M3 per-token migration flags passed to create() when the loaded IDL
   *  exposes them. When the IDL is pre-M3 they are NOT sent and
   *  sequence.migrationArgsSupported reports the drop (never silent). */
  autoMigrate?: boolean;
  lockLp?: boolean;
}

/** Derives every PDA for a launch, replicating the program's seeds. */
export function derivePdas(
  programId: PublicKey,
  creator: PublicKey,
  nonce: bigint
): LaunchPdas {
  // Little-endian u64 bytes without Buffer.writeBigUInt64LE (Node-only;
  // browser Buffer shims lack it). BigInt arithmetic only, no bigint
  // literals (project target is ES2017).
  const nonceBytes = Buffer.alloc(8);
  let v = nonce;
  for (let i = 0; i < 8; i++) {
    nonceBytes[i] = Number(v & BigInt(0xff));
    v = v >> BigInt(8);
  }
  const [mint] = PublicKey.findProgramAddressSync(
    [MINT_SEED, creator.toBuffer(), nonceBytes],
    programId
  );
  const [curveState] = PublicKey.findProgramAddressSync(
    [CURVE_SEED, mint.toBuffer()],
    programId
  );
  const [mintAuthority] = PublicKey.findProgramAddressSync(
    [MINT_AUTHORITY_SEED, mint.toBuffer()],
    programId
  );
  const [metadata] = PublicKey.findProgramAddressSync(
    [METADATA_SEED, METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    METAPLEX_PROGRAM_ID
  );
  return { mint, curveState, mintAuthority, metadata };
}

/** Builds one buy instruction via the anchor client (IDL account order).
 *  M3: the program's buy now also carries the recorded creator's wallet and
 *  ATA accounts (validated on-chain on every buy; used by the
 *  auto-graduation path when the fill buy finalizes the curve). */
export async function buildBuyIx(
  program: Program,
  buyer: PublicKey,
  pda: LaunchPdas,
  solInLamports: bigint,
  creator: PublicKey
): Promise<TransactionInstruction> {
  if (solInLamports <= BigInt(0)) {
    throw new Error(`buy amount must be positive, got ${solInLamports}`);
  }
  const buyerAta = await getAssociatedTokenAddress(
    pda.mint,
    buyer,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  const creatorAta = await getAssociatedTokenAddress(
    pda.mint,
    creator,
    false,
    TOKEN_2022_PROGRAM_ID
  );
  return program.methods
    .buy(new BN(solInLamports.toString()))
    .accounts({
      buyer,
      mint: pda.mint,
      curveState: pda.curveState,
      buyerAta,
      creatorAccount: creator,
      creatorAta,
      mintAuthority: pda.mintAuthority,
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      associatedTokenProgram: ASSOCIATED_TOKEN_PROGRAM_ID,
    })
    .instruction();
}

/** Whether the loaded IDL's create() carries the M3 migration args
 *  (auto_migrate + lock_lp). The anchor client normalizes IDL identifiers to
 *  camelCase (auto_migrate -> autoMigrate), so BOTH spellings are accepted.
 *  The client signs exactly what the IDL declares; sending the new args to a
 *  pre-M3 program would make the create decode fail on-chain, so callers
 *  must gate on this. */
export function createIxMigrationSupported(program: Program): boolean {
  const instructions = (
    program.idl as unknown as {
      instructions?: { name?: string; args?: { name?: string }[] }[];
    }
  ).instructions ?? [];
  const create = instructions.find((i) => i.name === "create");
  const argNames = (create?.args ?? []).map((a) => a.name ?? "");
  const hasAutoMigrate =
    argNames.includes("auto_migrate") || argNames.includes("autoMigrate");
  const hasLockLp = argNames.includes("lock_lp") || argNames.includes("lockLp");
  return hasAutoMigrate && hasLockLp;
}

/** Builds the create instruction via the anchor client (IDL account order).
 *  The M3 migration flags are appended to the create args ONLY when the
 *  loaded IDL declares them; on a pre-M3 IDL the 4-arg create is emitted and
 *  the caller is told via LaunchSequence.migrationArgsSupported. The flags
 *  are never silently dropped: buildLaunchSequence reports the capability
 *  alongside the built sequence. */
export async function buildCreateIx(
  program: Program,
  creator: PublicKey,
  pda: LaunchPdas,
  nonce: bigint,
  name: string,
  symbol: string,
  uri: string,
  opts?: { autoMigrate?: boolean; lockLp?: boolean }
): Promise<TransactionInstruction> {
  if (Buffer.byteLength(name, "utf8") > 32) throw new Error(`name too long: ${name}`);
  if (Buffer.byteLength(symbol, "utf8") > 10) throw new Error(`symbol too long: ${symbol}`);
  if (Buffer.byteLength(uri, "utf8") > 200) throw new Error(`uri too long: ${uri}`);
  const createMethod = program.methods.create as unknown as (
    nonce: BN,
    name: string,
    symbol: string,
    uri: string,
    autoMigrate?: boolean,
    lockLp?: boolean
  ) => ReturnType<typeof program.methods.create>;
  const builder = createIxMigrationSupported(program)
    ? createMethod(
        new BN(nonce.toString()),
        name,
        symbol,
        uri,
        opts?.autoMigrate ?? DEFAULT_AUTO_MIGRATE,
        opts?.lockLp ?? DEFAULT_LOCK_LP
      )
    : createMethod(new BN(nonce.toString()), name, symbol, uri);
  return builder
    .accounts({
      creator,
      mint: pda.mint,
      curveState: pda.curveState,
      mintAuthority: pda.mintAuthority,
      metadata: pda.metadata,
      sysvarInstructions: SYSVAR_INSTRUCTIONS_PUBKEY,
      systemProgram: SystemProgram.programId,
      token2022Program: TOKEN_2022_PROGRAM_ID,
      mplTokenMetadataProgram: METAPLEX_PROGRAM_ID,
      rent: SYSVAR_RENT_PUBKEY,
    })
    .instruction();
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
  ixs: TransactionInstruction[],
  wallets: Keypair[],
  blockhash: string,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number,
  signedSizeBytes: number
): BuyTx {
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
  tx.add(...ixs);
  return { tx, wallets, instructions: ixs, signedSize: signedSizeBytes };
}

/**
 * Greedily packs the dev buys into buy transactions under the byte budget.
 * Each wallet's buy is one instruction; the wallets sign their own buy and the
 * creator signs as fee payer. Measured: +155 bytes per wallet, 5 wallets max
 * per tx (1173 bytes), 4 wallets in the tip-carrying last tx.
 */
export async function packBuyTxs(opts: {
  program: Program;
  creator: Keypair;
  pda: LaunchPdas;
  buys: BuyAllocation[];
  blockhash: string;
  maxBuyTxBytes?: number;
  tipReserveBytes?: number;
  computeUnitLimit?: number;
  priorityFeeMicroLamports?: number;
}): Promise<BuyTx[]> {
  const {
    program,
    creator,
    pda,
    buys,
    blockhash,
    maxBuyTxBytes = DEFAULT_MAX_BUY_TX_BYTES,
    tipReserveBytes = DEFAULT_TIP_RESERVE_BYTES,
    computeUnitLimit = MAX_COMPUTE_UNITS,
    priorityFeeMicroLamports = DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS,
  } = opts;
  if (maxBuyTxBytes > MAX_TX_BYTES) {
    throw new Error(`maxBuyTxBytes ${maxBuyTxBytes} > hard limit ${MAX_TX_BYTES}`);
  }
  const budget = maxBuyTxBytes - tipReserveBytes;

  const out: BuyTx[] = [];
  let current: { wallets: Keypair[]; ixs: TransactionInstruction[] } | null = null;
  let currentSize = 0;

  for (const buy of buys) {
    const ix = await buildBuyIx(program, buy.wallet.publicKey, pda, buy.solInLamports, creator.publicKey);
    if (!current) current = { wallets: [], ixs: [] };
    const candidate: { wallets: Keypair[]; ixs: TransactionInstruction[] } = {
      wallets: [...current.wallets, buy.wallet],
      ixs: [...current.ixs, ix],
    };
    const size = signedSize(
      creator,
      candidate.ixs,
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
          current.ixs,
          current.wallets,
          blockhash,
          computeUnitLimit,
          priorityFeeMicroLamports,
          currentSize
        )
      );
      current = { wallets: [buy.wallet], ixs: [ix] };
      currentSize = signedSize(
        creator,
        [ix],
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
        current.ixs,
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
 * Builds the full launch sequence. All txs share one recent blockhash so the
 * same signed txs can either be sent sequentially (Tier 1) or packed into a
 * single Jito bundle with the same blockhash (Tier 2).
 */
export async function buildLaunchSequence(
  opts: BuildLaunchOptions
): Promise<LaunchSequence> {
  const {
    program,
    connection,
    creator,
    nonce,
    name,
    symbol,
    uri,
    buys,
    fundLamportsPerWallet = null,
    maxBuyTxBytes,
    tipReserveBytes,
    computeUnitLimit,
    priorityFeeMicroLamports,
    autoMigrate,
    lockLp,
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

  const pda = derivePdas(program.programId, creator.publicKey, nonce);
  const latest = await connection.getLatestBlockhash("confirmed");
  const blockhash = { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };

  const migrationArgsSupported = createIxMigrationSupported(program);
  const createIx = await buildCreateIx(
    program,
    creator.publicKey,
    pda,
    nonce,
    name,
    symbol,
    uri,
    { autoMigrate, lockLp }
  );
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

  const buyTxs = await packBuyTxs({
    program,
    creator,
    pda,
    buys,
    blockhash: latest.blockhash,
    maxBuyTxBytes,
    tipReserveBytes,
    computeUnitLimit: cuLimit,
    priorityFeeMicroLamports: priorityFee,
  });

  const signersByTx: Keypair[][] = [];
  if (fundTx) signersByTx.push([creator]);
  signersByTx.push([creator]);
  for (const bt of buyTxs) signersByTx.push([creator, ...bt.wallets]);

  return {
    pda,
    creator,
    nonce,
    name,
    symbol,
    uri,
    migrationArgsSupported,
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

/**
 * Pre-flight simulation of the whole launch. The create tx simulates
 * standalone against the live chain. Buy txs cannot simulate standalone on a
 * fresh mint (the curve does not exist yet), so each buy tx is validated in a
 * sandbox tx that runs the create instruction first, then the buy
 * instructions in chunks of up to 3 wallets (the sandbox tx must stay under
 * the 1232-byte serialization limit). A failed simulation is a hard error.
 */
export async function preflightLaunch(
  connection: Connection,
  seq: LaunchSequence,
  opts: { chunkSize?: number } = {}
): Promise<{
  create: SimResult;
  buyChunks: { buyTxIndex: number; walletCount: number; result: SimResult }[];
}> {
  // With funding, the sandbox must fund each chunk's wallets too, and the
  // fund + create + chunk buys must stay under the 1232-byte limit: chunk 2
  // (measured: create + 2 buys + 2 transfers ≈ 1045 bytes). Without funding,
  // chunk 3 fits (create + 3 buys = 1068).
  const chunkSize = opts.chunkSize ?? (seq.fundIx ? 2 : 3);
  const latest = await connection.getLatestBlockhash("confirmed");

  // 1) create tx standalone, preceded by the funding transfers (the wallets
  //    must hold lamports in the sandbox for their buys to pass).
  const createTx = new Transaction({
    feePayer: seq.creator.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: 0,
  });
  createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }));
  if (seq.fundIx) createTx.add(...seq.fundIx);
  createTx.add(seq.createIx);
  const create = await simulateTx(connection, createTx, [seq.creator]);
  if (create.err) {
    throw new Error(`preflight: create simulation failed: ${JSON.stringify(create.err)}`);
  }

  // 2) each buy tx, sandboxed behind fund + create instructions
  const buyChunks: { buyTxIndex: number; walletCount: number; result: SimResult }[] = [];
  let walletOffset = 0;
  for (let i = 0; i < seq.buyTxs.length; i++) {
    const bt = seq.buyTxs[i];
    for (let s = 0; s < bt.wallets.length; s += chunkSize) {
      const chunkWallets = bt.wallets.slice(s, s + chunkSize);
      const chunkIxs = bt.instructions.slice(s, s + chunkSize);
      const chunkFundIx = seq.fundIxPerWallet
        ? seq.fundIxPerWallet.slice(walletOffset + s, walletOffset + s + chunkSize)
        : [];
      const tx = new Transaction({
        feePayer: seq.creator.publicKey,
        blockhash: latest.blockhash,
        lastValidBlockHeight: 0,
      });
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }));
      tx.add(...chunkFundIx, seq.createIx, ...chunkIxs);
      const result = await simulateTx(connection, tx, [seq.creator, ...chunkWallets]);
      if (result.err) {
        throw new Error(
          `preflight: buy tx ${i} chunk ${s / chunkSize} simulation failed: ${JSON.stringify(result.err)}`
        );
      }
      buyChunks.push({ buyTxIndex: i, walletCount: chunkWallets.length, result });
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
              .join(", ")}); the token may be partially launched. A fresh launch uses a new nonce and creates a NEW mint; do not re-send this sequence.`
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

/** Reads a wallet's Token-2022 balance for the launch mint (raw units). */
export async function walletTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  const ata = await getAssociatedTokenAddress(mint, wallet, false, TOKEN_2022_PROGRAM_ID);
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

/** Lamports needed by each wallet to buy and create its ATA on first buy.
 *  Token-2022 token accounts are 170 bytes (165 base + TLV header space), as
 *  measured via the ATA program's GetAccountDataSize CPI on devnet; 165 bytes
 *  (the legacy SPL token size) is short by ~21k lamports of rent. */
export async function ataRentLamports(connection: Connection): Promise<number> {
  return connection.getMinimumBalanceForRentExemption(170, "confirmed");
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
