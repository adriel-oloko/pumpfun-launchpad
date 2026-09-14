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
// - The sequence can be sent as normal transactions (Tier 1) or assembled
//   into an atomic relay bundle (Tier 2, see relays.ts + fanout-submit.ts).
//   Tier 1 sends through the shared Helius Sender SWQOS-only submission
//   layer (sendProtectedTx in lib/bundle/protected-send.ts, the same sender
//   the buy/sell/auto paths use): on MAINNET every launch tx (fund/create/
//   each packed buy) carries its own flat 5,000-lamport (0.000005 SOL) Sender
//   tip as its LAST instruction plus its own setComputeUnitPrice priority fee
//   (already baked in below — no second fee ix is added); on DEVNET it falls
//   back to the plain raw-RPC send (sendAndConfirmWithRetry), unchanged.
//
// The curve economics are identical to the old custom program (30 SOL
// virtual reserve, 1.073B virtual token reserve, 1% fee, 85 SOL graduation,
// 6 decimals, 1e9 supply — lib/params.ts, unchanged).

import {
  ACCOUNT_SIZE,
  ACCOUNT_TYPE_SIZE,
  AccountType,
  ExtensionType,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
  getExtensionData,
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
  PUMP_FEE_BPS,
  PUMP_METAPLEX_PROGRAM_ID,
  buildPumpBuyIx,
  buildPumpCreateIx,
  buildPumpExtendAccountIx,
  pumpBondingCurvePda,
  pumpMetadataPda,
  pumpMintAuthorityPda,
  quotePumpChunk,
  readPumpCurveState,
  readPumpGlobalParams,
  resolvePumpFeeRecipient,
} from "../pump";
import {
  buildPumpMigrateV2Ix,
  canonicalMigratedPoolPda,
  classifyMigrateOutcome,
  readMigrateChainState,
  type MigrateStatus,
} from "../migrate";
import { VIRTUAL_TOKEN_RESERVE, virtualSolReserveFallback } from "../params";
import { solanaNetwork } from "../network";
import { DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS } from "../fees";
import { isBlockhashExpiredError } from "../tx-errors";
import { grindVanityMintKeypair } from "../vanity";
import { sendProtectedTx } from "./protected-send";

/** Metaplex token metadata program id (pump.fun's create metadata PDA is
 *  derived under it). */
export const METAPLEX_PROGRAM_ID: PublicKey = PUMP_METAPLEX_PROGRAM_ID;

/** Hard Solana limits (lamport-free, spec constants). */
export const MAX_TX_BYTES = 1232;
export const MAX_COMPUTE_UNITS = 1_400_000;

/** Per-tx compute-unit limits for the REAL bundle txs. Stamping
 *  MAX_COMPUTE_UNITS on every tx made a 3-tx launch bundle reserve 4.2M CU,
 *  which Jito's cost model rejected (ExceedsCostModel -> Invalid). Measured
 *  consumption: create ~111k, buy (incl. ATA create + tip) ~205k. The explicit
 *  MigrateV2 (pool + ATAs + LP mint + boost CPIs) gets the manual runner's
 *  400k ceiling. */
export const CREATE_CU_LIMIT = 150_000;
/** CU ceiling for the FOLDED tx A (create_v2 + extend_account + the creator's
 *  own ATA create + dev buy). The reference folded tx consumed 198,662 CU, so
 *  CREATE_CU_LIMIT (150,000) is too low. At 1 lamport/CU this raises tx A's
 *  priority fee from ~150,000 to ~400,000 lamports. */
export const CREATE_BUY_CU_LIMIT = 400_000;
export const BUY_CU_LIMIT = 250_000;
export const MIGRATE_CU_LIMIT = 400_000;

/** Real-token-reserve fallback for a FRESH curve when the live PUMP_GLOBAL
 *  read fails. The real token reserve is identical on mainnet and devnet
 *  (only the virtual SOL seed differs), so one constant covers both. */
export const REAL_TOKEN_RESERVE_FALLBACK: bigint = BigInt(
  "793100000000000"
);

/** Default serialized-byte budget for a buy tx. Every mainnet-launch buy tx
 *  now carries its OWN Sender tip transfer (~90 bytes) — Tier 1 sequential
 *  sends go through sendProtectedTx (lib/bundle/protected-send.ts) and Tier
 *  2 puts a relay tip in its final tx — so each packed buy tx reserves
 *  tipReserveBytes of its budget: packed to maxBuyTxBytes - tipReserveBytes. */
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

/** One dev wallet's planned buy. */
export interface BuyAllocation {
  wallet: Keypair;
  /** Planned GROSS SOL this wallet commits (the buy's `max_sol_cost`
   *  ceiling), lamports. The program floors its 125 bps input fee per buy, so
   *  the curve receives the NET (`quoteLaunchBuys().costLamports`); the
   *  graduating buy takes the remaining real tokens and closes any floor
   *  shortfall. */
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
  createTx: Transaction | VersionedTransaction;
  /** The launch ALT tx A (when folded) was compiled against; null for the
   *  legacy create-only tx. sendSequentially needs it to re-append the Sender
   *  tip to the V0 message. */
  lookupTable: AddressLookupTableAccount | null;
  buyTxs: BuyTx[];
  /** Explicit pump.fun MigrateV2 (canonical pool creation) sent AFTER the
   *  fill buys, in the same slot. Signed by the creator alone. Idempotent by
   *  STATE: the sender reads the canonical pool before sending and skips the
   *  tx when that pool already holds this mint; a revert is only accepted when
   *  the chain shows this mint's pool (never from an error code). NULL when
   *  the build was asked for a create+buys-only sequence (`includeMigrate:
   *  false`).
   */
  migrateIx: TransactionInstruction | null;
  migrateTx: Transaction | null;
  blockhash: { blockhash: string; lastValidBlockHeight: number };
  /** Signers per tx, aligned with [fund?, create, ...buyTxs, migrate]. */
  signersByTx: Keypair[][];
}

export interface BuildLaunchOptions {
  connection: Connection;
  /** Creator: signs create (with the mint keypair), pays the create tx and
   *  the explicit MigrateV2. NOT the fee payer of the fill buys: each buy tx
   *  is paid by the pair's first wallet. Any wallet funding must happen in a
   *  separate, earlier tx (never inside the launch pack). */
  creator: Keypair;
  name: string;
  symbol: string;
  uri: string;
  /** The selected dev wallets and their buy amounts. */
  buys: BuyAllocation[];
  /** The creator's OWN dev buy, spent from the creator's own SOL and FOLDED
   *  into tx A (quoted FIRST, before every dev-wallet chunk). When null
   *  (default) tx A stays the legacy create-only tx and every buy is packed
   *  as before. Requires `lookupTable`. */
  creatorDevBuy?: { wallet: Keypair; solInLamports: bigint } | null;
  /** The launch address lookup table. REQUIRED when `creatorDevBuy` is set
   *  (the folded tx A is a V0 message compiled against it); ignored by the
   *  legacy create-only path. */
  lookupTable?: AddressLookupTableAccount | null;
  /** Optional: lamports each wallet receives from the creator (funding tx).
   *  A single value applies to every wallet; an array applies per wallet. */
  fundLamportsPerWallet?: bigint | bigint[] | null;
  /** Byte budget per buy tx (default 1150; measured: 2 wallets = 1060). */
  maxBuyTxBytes?: number;
  /** Bytes reserved in the last buy tx for the bundle tip transfer. */
  tipReserveBytes?: number;
  /** Optional per-tx compute-unit limit override. When omitted, the REAL
   *  bundle txs use per-tx defaults: the create tx stamps CREATE_CU_LIMIT and
   *  every buy tx stamps BUY_CU_LIMIT. */
  computeUnitLimit?: number;
  /** Optional priority fee in micro-lamports per CU on every buy tx. */
  priorityFeeMicroLamports?: number;
  /** Slippage headroom (basis points) on every pre-fill buy's max_sol_cost
   *  quote (default 10%: covers reserve drift + the fee-program split). */
  slippageBps?: bigint;
  /** Optional pre-generated mint keypair (e.g. a vanity keypair whose base58
   *  ADDRESS ends in "pump", ground with Web Workers by the launch panel).
   *  When omitted, a fresh vanity mint keypair is grinded here with the
   *  CJS-safe single-threaded libsodium core (lib/vanity.ts) — the Node CLI
   *  scripts' path. Every mint this launchpad creates therefore ends in
   *  "pump", exactly like real pump.fun tokens. Cosmetic only: the ticker's
   *  `.pump` SUFFIX is still indexer-applied; name/symbol/uri are untouched. */
  mintKeypair?: Keypair;
  /** Build the explicit MigrateV2 tx (default true). When false the sequence
   *  is create + buys only: the shape the mainnet pre-migration sell-all test
   *  needs. The default path (undefined/true) is unchanged. */
  includeMigrate?: boolean;
  /** Whether the final buy graduates the curve (default true). When false
   *  EVERY buy takes only its planned share and the MigrateV2 tx is omitted
   *  automatically (a non-graduating launch must not create the canonical
   *  pool), so callers do not have to set both flags. The operator's UI test
   *  launch uses this to create a coin that stays on the open curve. */
  graduate?: boolean;
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
 * Resolves the curve seed a FRESH launch quotes against: the LIVE
 * `PUMP_GLOBAL` account on success (devnet seeds 1 SOL of virtual SOL,
 * mainnet 30 SOL — the D-2 trap), otherwise the cluster-keyed fallback. The
 * virtual token reserve is identical on both clusters; the real token reserve
 * is identical on BOTH clusters too (only the virtual SOL seed differs).
 */
export async function resolveLaunchCurveSeed(connection: Connection): Promise<{
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  realTokenReserves: bigint;
}> {
  try {
    const g = await readPumpGlobalParams(connection);
    return {
      virtualSolReserves: g.initialVirtualSolReserves,
      virtualTokenReserves: g.initialVirtualTokenReserves,
      realTokenReserves: g.initialRealTokenReserves,
    };
  } catch {
    return {
      virtualSolReserves: virtualSolReserveFallback(solanaNetwork()),
      virtualTokenReserves: VIRTUAL_TOKEN_RESERVE,
      realTokenReserves: REAL_TOKEN_RESERVE_FALLBACK,
    };
  }
}

/** Per-wallet launch buy args (aligned 1:1 with `buys`). */
export interface LaunchBuyQuote {
  tokensOut: bigint;
  maxSolCost: bigint;
  /** Curve-computed NET SOL this buy adds to the virtual SOL reserve. */
  costLamports: bigint;
}

/**
 * Quotes every pre-fill buy against the curve's INITIAL reserves, chaining
 * each chunk's simulated reserve movement into the next quote. `seed` is the
 * caller-resolved cluster seed (`resolveLaunchCurveSeed`): a fresh curve
 * starts there before any buy can land.
 *
 * `BuyAllocation.solInLamports` is the planned GROSS budget; each
 * non-graduating chunk derives `tokens_out` from the per-buy fee floor
 * (`net = floor(gross*9875/10000)`) and quotes the forward cost with
 * `quotePumpChunk`. By default (`graduate` true) the FINAL buy is forced to
 * take ALL remaining real tokens (the curve hard cap), so the curve completes
 * no matter how the earlier per-buy floors rounded. With `graduate: false`
 * every buy — including the last — takes only ITS planned share, leaving the
 * curve open (the operator's UI test launch).
 */
export function quoteLaunchBuys(
  buys: BuyAllocation[],
  slippageBps: bigint | undefined,
  seed: {
    virtualSolReserves: bigint;
    virtualTokenReserves: bigint;
    realTokenReserves: bigint;
  },
  /** When true (default) the final buy graduates the curve; when false every
   *  buy takes only its planned share and the curve stays open. */
  graduate: boolean = true
): LaunchBuyQuote[] {
  let vsr = seed.virtualSolReserves;
  let vtr = seed.virtualTokenReserves;
  let rtr = seed.realTokenReserves;
  const quotes: LaunchBuyQuote[] = [];
  for (let i = 0; i < buys.length; i++) {
    const isLast = graduate && i === buys.length - 1;
    let tokensOut: bigint;
    if (isLast) {
      // The graduating buy takes every remaining real token.
      tokensOut = rtr;
    } else {
      const gross = buys[i].solInLamports;
      if (gross <= BigInt(0)) {
        throw new Error(
          `launch buy ${i} has a non-positive planned budget ${gross}`
        );
      }
      const net = (gross * (BigInt(10_000) - PUMP_FEE_BPS)) / BigInt(10_000);
      tokensOut = (net * vtr) / (vsr + net);
    }
    const q = quotePumpChunk(
      { virtualSolReserves: vsr, virtualTokenReserves: vtr, realTokenReserves: rtr },
      tokensOut,
      slippageBps
    );
    vsr = vsr + q.costLamports;
    vtr = vtr - q.tokensOut;
    rtr = rtr - q.tokensOut;
    quotes.push({
      tokensOut: q.tokensOut,
      maxSolCost: q.maxSolCost,
      costLamports: q.costLamports,
    });
  }
  return quotes;
}

/** Serialized size of a signed buy tx. The pair's FIRST wallet is the fee
 *  payer, so only the pair signs (the creator is NOT on fill txs). */
function signedSize(
  ixs: TransactionInstruction[],
  wallets: Keypair[],
  blockhash: string,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number
): number {
  const tx = new Transaction({ feePayer: wallets[0].publicKey, blockhash, lastValidBlockHeight: 0 });
  tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: computeUnitLimit }));
  if (priorityFeeMicroLamports > 0) {
    tx.add(
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: priorityFeeMicroLamports,
      })
    );
  }
  tx.add(...ixs);
  tx.sign(...wallets);
  try {
    return tx.serialize().length;
  } catch {
    // Transaction.serialize throws past the 1232-byte hard limit; a tx that
    // cannot serialize is by definition over the byte budget.
    return MAX_TX_BYTES + 1;
  }
}

/** Materializes one packed buy tx (unsigned). The pair's FIRST wallet is the
 *  fee payer; the creator is absent from every fill tx. */
function materializeBuyTx(
  walletIxs: TransactionInstruction[][],
  wallets: Keypair[],
  blockhash: string,
  computeUnitLimit: number,
  priorityFeeMicroLamports: number,
  signedSizeBytes: number
): BuyTx {
  const instructions = walletIxs.flat();
  const tx = new Transaction({
    feePayer: wallets[0].publicKey,
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
 * buy); the pair's FIRST wallet is the fee payer and the pair signs its own
 * buy — the creator is NOT on the fill txs. Measured (M10): ~200
 * bytes/wallet, 2 wallets max per tx, 3 overflow the 1232-byte limit.
 */
export function packBuyTxs(opts: {
  creator: Keypair;
  pda: LaunchPdas;
  buys: BuyAllocation[];
  quotes: { tokensOut: bigint; maxSolCost: bigint }[];
  /** The LIVE protocol fee recipient (resolvePumpFeeRecipient) baked into
   *  every buy instruction. */
  feeRecipient: PublicKey;
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
    feeRecipient,
    blockhash,
    maxBuyTxBytes = DEFAULT_MAX_BUY_TX_BYTES,
    tipReserveBytes = DEFAULT_TIP_RESERVE_BYTES,
    computeUnitLimit = BUY_CU_LIMIT,
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
      feeRecipient,
      tokensOut: quote.tokensOut,
      maxSolCost: quote.maxSolCost,
    });
    if (!current) current = { wallets: [], walletIxs: [] };
    const candidate: { wallets: Keypair[]; walletIxs: TransactionInstruction[][] } = {
      wallets: [...current.wallets, buy.wallet],
      walletIxs: [...current.walletIxs, ixs],
    };
    const size = signedSize(
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
    creatorDevBuy = null,
    lookupTable = null,
    fundLamportsPerWallet = null,
    maxBuyTxBytes,
    tipReserveBytes,
    computeUnitLimit,
    priorityFeeMicroLamports,
    slippageBps,
    includeMigrate = true,
    graduate = true,
  } = opts;
  if (buys.length === 0) throw new Error("at least one dev wallet buy is required");
  if (creatorDevBuy && !lookupTable) {
    throw new Error(
      "lookupTable is required when creatorDevBuy is set (folded tx A is a V0 message)"
    );
  }

  // M7a fee policy: resolve the knobs once so the create tx, the fund tx and
  // every packed buy tx carry the SAME compute-unit price (env-tunable
  // lib/fees.ts default when omitted). Per-tx CU budgeting: the create tx
  // stamps CREATE_CU_LIMIT (or CREATE_BUY_CU_LIMIT when the creator's dev buy
  // is folded into it) and each buy tx stamps BUY_CU_LIMIT (measured
  // consumption: create ~111k, folded create+buy ~199k, buy incl. ATA create
  // + tip ~205k). Stamping MAX_COMPUTE_UNITS on every tx made a 3-tx launch
  // bundle reserve 4.2M CU, which Jito's cost model rejected
  // (ExceedsCostModel -> Invalid). The fund tx is a plain transfer and gets
  // no CU-limit ix. A caller-supplied computeUnitLimit overrides both per-tx
  // defaults.
  const priorityFee = priorityFeeMicroLamports ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  const createCuLimit =
    computeUnitLimit ?? (creatorDevBuy ? CREATE_BUY_CU_LIMIT : CREATE_CU_LIMIT);
  const buyCuLimit = computeUnitLimit ?? BUY_CU_LIMIT;
  const migrateCuLimit = computeUnitLimit ?? MIGRATE_CU_LIMIT;
  const addFeeIxs = (tx: Transaction, cuLimit?: number): void => {
    if (cuLimit !== undefined) {
      tx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: cuLimit }));
    }
    if (priorityFee > 0) {
      tx.add(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: priorityFee,
        })
      );
    }
  };

  // M10: the mint is a FRESH Keypair generated client-side (never a PDA, and
  // never lost: it signs the create tx in signersByTx[create]). Vanity:
  // unless the caller supplies a pre-ground keypair (the launch panel grinds
  // with a Web Worker pool, lib/vanity-client.ts), grind one here with the
  // CJS-safe single-threaded libsodium core so EVERY mint this launchpad
  // creates has a base58 ADDRESS ending in "pump" — including the Node CLI
  // scripts that compile this file to CommonJS.
  const mintKeypair = opts.mintKeypair ?? (await grindVanityMintKeypair());
  const pda = deriveLaunchPdas(mintKeypair.publicKey);
  const latest = await connection.getLatestBlockhash("confirmed");
  const blockhash = { blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight };

  // M10 + fee-rotation fix: resolve the protocol fee recipient LIVE from the
  // pump.fun global account (pump.fun rotates it; a stale constant reverts
  // every buy with Custom 6000). The value is baked into every buy ix.
  const feeRecipient = await resolvePumpFeeRecipient(connection);

  const createIx = buildPumpCreateIx({
    creator: creator.publicKey,
    mint: mintKeypair.publicKey,
    name,
    symbol,
    uri,
  });

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
  // M10 + D-2: resolve the curve seed LIVE from the pump.fun global account
  // (devnet 1 SOL vs mainnet 30 SOL virtual SOL). A hardcoded seed silently
  // under-buys a devnet launch by ~30x. Fall back per cluster on a failed
  // read.
  const seed = await resolveLaunchCurveSeed(connection);
  // Fold the creator's own dev buy FIRST: quote it against the fresh curve,
  // then chain every dev-wallet chunk against the reserves its buy leaves
  // behind. `packBuyTxs` receives `buys` WITHOUT it, so the folded buy is
  // never packed into a buy tx. The graduating rule still lands on the LAST
  // buy of the whole sequence (the last dev-wallet chunk).
  const foldedAllocations: BuyAllocation[] = creatorDevBuy
    ? [{ wallet: creatorDevBuy.wallet, solInLamports: creatorDevBuy.solInLamports }, ...buys]
    : buys;
  const quotes = quoteLaunchBuys(foldedAllocations, slippageBps, seed, graduate);
  const creatorQuote = creatorDevBuy ? quotes[0] : null;
  const buyQuotes = creatorDevBuy ? quotes.slice(1) : quotes;

  let createTx: Transaction | VersionedTransaction;
  if (creatorDevBuy && creatorQuote) {
    // Reference tx A shape: ONE V0 message compiled against the launch ALT,
    // carrying ComputeBudget(limit), ComputeBudget(price), create_v2,
    // extend_account, the creator's own ATA createIdempotent, and the
    // creator's own dev buy. The Sender tip is appended later by
    // sendProtectedTx, still LAST. Only [creator, mint] sign it and the
    // creator is the fee payer.
    const extendIx = buildPumpExtendAccountIx({
      bondingCurve: pda.curveState,
      user: creator.publicKey,
    });
    const creatorBuyIxs = buildPumpBuyIx({
      mint: mintKeypair.publicKey,
      buyer: creator.publicKey,
      creator: creator.publicKey,
      feeRecipient,
      tokensOut: creatorQuote.tokensOut,
      maxSolCost: creatorQuote.maxSolCost,
    });
    const createInstructions: TransactionInstruction[] = [
      ComputeBudgetProgram.setComputeUnitLimit({ units: createCuLimit }),
    ];
    if (priorityFee > 0) {
      createInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee })
      );
    }
    createInstructions.push(createIx, extendIx, ...creatorBuyIxs);
    const message = new TransactionMessage({
      payerKey: creator.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: createInstructions,
    }).compileToV0Message([lookupTable as AddressLookupTableAccount]);
    createTx = new VersionedTransaction(message);
  } else {
    createTx = new Transaction({ feePayer: creator.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: 0 });
    addFeeIxs(createTx, createCuLimit);
    createTx.add(createIx);
  }

  const buyTxs = packBuyTxs({
    creator,
    pda,
    buys,
    quotes: buyQuotes,
    feeRecipient,
    blockhash: latest.blockhash,
    maxBuyTxBytes,
    tipReserveBytes,
    computeUnitLimit: buyCuLimit,
    priorityFeeMicroLamports: priorityFee,
  });

  // C3: the explicit MigrateV2 is the LAST launch tx. The reference coins
  // created the canonical pool in a separate transaction after the fill buys
  // (the fill txs contained no CreatePool), so the launch must not rely on
  // the graduating buy to migrate. Signed by the creator alone and sent in the
  // same slot. Idempotency is decided by chain state, not error text: the
  // sender reads the canonical pool before sending and skips the tx when that
  // pool already holds this mint.
  // `includeMigrate: false` (mainnet pre-migration sell-all test) omits it and
  // the sequence is create + buys only. A NON-graduating launch (`graduate:
  // false`) also omits it automatically: the curve stays open, so there is no
  // pool to create. Callers never have to set both flags.
  const buildMigrate = graduate && includeMigrate;
  let migrateIx: TransactionInstruction | null = null;
  let migrateTx: Transaction | null = null;
  if (buildMigrate) {
    migrateIx = buildPumpMigrateV2Ix({
      baseMint: mintKeypair.publicKey,
      user: creator.publicKey,
    });
    migrateTx = new Transaction({
      feePayer: creator.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: 0,
    });
    addFeeIxs(migrateTx, migrateCuLimit);
    migrateTx.add(migrateIx);
  }

  const signersByTx: Keypair[][] = [];
  if (fundTx) signersByTx.push([creator]);
  signersByTx.push([creator, mintKeypair]);
  for (const bt of buyTxs) signersByTx.push([...bt.wallets]);
  if (migrateIx) signersByTx.push([creator]);

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
    lookupTable: lookupTable ?? null,
    buyTxs,
    migrateIx,
    migrateTx,
    blockhash,
    signersByTx,
  };
}

/** An assembled Tier 2 relay bundle: the launch txs plus their matching
 *  signer lists, with the explicit MigrateV2 removed when the canonical pool
 *  already exists. */
export interface LaunchBundlePack {
  // Tier 2 needs a separate V0 pass: the folded create tx is a
  // VersionedTransaction and the relay assembler below still assumes legacy.
  txs: (Transaction | VersionedTransaction)[];
  signersByTx: Keypair[][];
  /** True when the migrate tx was dropped because the pool already existed. */
  migrateDropped: boolean;
  /** The canonical PumpSwap pool PDA for the launch mint. */
  poolKey: PublicKey;
  /** The curve's `complete` flag (false when the curve does not exist yet). */
  curveComplete: boolean;
}

/**
 * Tier 2 idempotency guard (spec section 8 item 4). An atomic relay bundle
 * cannot contain a transaction that is expected to revert, so before
 * submitting the bundle this reads the curve completion flag and the canonical
 * PumpSwap pool account. When the pool already exists the explicit MigrateV2
 * (and its signer entry) is dropped from the bundle — otherwise the whole
 * atomic bundle would revert on the already-migrated coin. The decision is the
 * pool-exists read, never an error code.
 *
 * Pure with respect to the launch: it only READS the chain and never builds or
 * sends a transaction. A fresh mint has neither a curve nor a pool, so the
 * normal path keeps the migrate tx.
 */
export async function assembleLaunchBundle(
  connection: Connection,
  seq: LaunchSequence
): Promise<LaunchBundlePack> {
  const [poolKey] = canonicalMigratedPoolPda(seq.pda.mint);
  const [curveRead, poolInfo] = await Promise.all([
    readPumpCurveState(connection, seq.pda.mint),
    connection.getAccountInfo(poolKey, "confirmed"),
  ]);
  const poolExists = poolInfo !== null;

  const txs: (Transaction | VersionedTransaction)[] = [];
  if (seq.fundTx) txs.push(seq.fundTx);
  txs.push(seq.createTx);
  for (const bt of seq.buyTxs) txs.push(bt.tx);

  const signersByTx: Keypair[][] = [...seq.signersByTx];
  let migrateDropped = false;
  if (seq.migrateTx) {
    if (poolExists) {
      // signersByTx ends with the migrate signer entry, matching the migrate tx.
      signersByTx.pop();
      migrateDropped = true;
    } else {
      txs.push(seq.migrateTx);
    }
  }

  return {
    txs,
    signersByTx,
    migrateDropped,
    poolKey,
    curveComplete: curveRead.kind === "ok" && curveRead.curve.complete,
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

/** The [fund?, create, ...buys, migrate] tx list in execution order. */
export function sequenceTxs(
  seq: LaunchSequence
): (Transaction | VersionedTransaction)[] {
  const txs: (Transaction | VersionedTransaction)[] = [];
  if (seq.fundTx) txs.push(seq.fundTx);
  txs.push(seq.createTx);
  for (const bt of seq.buyTxs) txs.push(bt.tx);
  if (seq.migrateTx) txs.push(seq.migrateTx);
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

  // 1) tx A standalone. The FOLDED tx A is a V0 message (create_v2 +
  //    extend_account + the creator's own ATA create + dev buy), so it is
  //    recompiled over a fresh blockhash with the launch ALT and simulated
  //    as a whole: the create and the creator's buy are atomic, so a
  //    standalone simulation is exactly what lands. The LEGACY create-only
  //    path rebuilds a legacy tx, preceded by up to two funding transfers
  //    (the sandbox must stay under the 1232-byte limit even for large
  //    rosters; each buy sandbox below funds its own wallet, so a full
  //    funding sweep is never needed here). A failed simulation is a hard
  //    error.
  let create: SimResult;
  if (seq.createTx instanceof VersionedTransaction) {
    const alt = lookupTable ?? seq.lookupTable;
    if (!alt) {
      throw new Error(
        "preflight: the folded create tx is V0 but no lookup table was supplied"
      );
    }
    const decompiled = TransactionMessage.decompile(seq.createTx.message, {
      addressLookupTableAccounts: [alt],
    });
    const message = new TransactionMessage({
      payerKey: seq.creator.publicKey,
      recentBlockhash: latest.blockhash,
      instructions: decompiled.instructions,
    }).compileToV0Message([alt]);
    const v0 = new VersionedTransaction(message);
    v0.sign([seq.creator, seq.mintKeypair]);
    const r = await connection.simulateTransaction(v0);
    create = {
      err: r.value.err ?? null,
      unitsConsumed: r.value.unitsConsumed ?? null,
      logs: r.value.logs ?? null,
    };
  } else {
    const createTx = new Transaction({
      feePayer: seq.creator.publicKey,
      blockhash: latest.blockhash,
      lastValidBlockHeight: 0,
    });
    createTx.add(ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }));
    if (seq.fundIx) createTx.add(...seq.fundIx.slice(0, 2));
    createTx.add(seq.createIx);
    create = await simulateTx(connection, createTx, [
      seq.creator,
      seq.mintKeypair,
    ]);
  }
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

/** One confirmed launch tx. `status`/`reason` are set on the migrate entry by
 *  the state classifier (`classifyMigrateOutcome`) and are NEVER derived from
 *  an error code. */
export interface SentLaunchTx {
  label: string;
  signature: string;
  status?: MigrateStatus;
  reason?: string;
}

/** The confirmed/failed tx signature a sender embeds in its message as
 *  `label (SIG) ...`, when present. Used only to surface the idempotent
 *  migrate revert; never to fabricate a success. */
function signatureFromError(msg: string): string {
  const m = msg.match(/\(([1-9A-HJ-NP-Za-km-z]{32,88})\)/);
  return m ? m[1] : "";
}

/** Sends the sequence as normal transactions, confirming each (Tier 1).
 *  Each tx goes through the shared Helius Sender SWQOS-only sender
 *  (sendProtectedTx): on MAINNET it is re-signed per attempt with the tx's
 *  own existing setComputeUnitPrice ix (skipPriorityFeeIx — no second fee
 *  ix), a flat 5,000-lamport Sender tip as the LAST instruction, submitted
 *  to the mev-protect SWQOS endpoint and confirmed by signature; on DEVNET
 *  sendProtectedTx falls back to sendAndConfirmWithRetry (plain raw RPC,
 *  unchanged). Either way a stale/expired blockhash is retried with a fresh
 *  one (up to 3 attempts), never a bare failure or a hang. A mid-sequence
 *  failure throws with the partial-state context: the txs that already
 *  confirmed are named so the caller never mistakes a partial launch for a
 *  no-op.
 *
 *  The explicit MigrateV2's outcome is decided by CHAIN STATE, never by an
 *  error code: the canonical pool is read before the tx is sent (skip when it
 *  already holds this mint) and re-read after a failure. A revert is accepted
 *  only when that pool exists with this mint's base_mint. An atomic relay
 *  bundle cannot swallow one tx's revert, so this handling is Tier 1 only. */
export async function sendSequentially(
  connection: Connection,
  seq: LaunchSequence,
  opts: { confirmTimeoutMs?: number; onSignature?: (label: string, sig: string) => void } = {}
): Promise<SentLaunchTx[]> {
  const confirmTimeoutMs = opts.confirmTimeoutMs ?? 45_000;
  const txs = sequenceTxs(seq);
  const labels: string[] = [];
  if (seq.fundTx) labels.push("fund");
  labels.push("create");
  for (let i = 0; i < seq.buyTxs.length; i++) labels.push(`buy${i + 1}`);
  if (seq.migrateTx) labels.push("migrate");

  const sent: SentLaunchTx[] = [];
  for (let i = 0; i < txs.length; i++) {
    const label = labels[i];
    // MIGRATE PRECONDITION (chain state, never error text): when the canonical
    // pool for THIS mint already exists the tx would only revert, so drop it
    // and record the state-decided outcome. A fresh launch has no pool, so the
    // normal path sends exactly as before.
    if (label === "migrate") {
      const state = await readMigrateChainState(connection, seq.pda.mint);
      if (state.poolExists && state.poolBaseMintMatchesMint) {
        const outcome = classifyMigrateOutcome({
          sent: false,
          sendError: null,
          poolKey: state.poolKey.toBase58(),
          poolExists: true,
          poolBaseMintMatchesMint: true,
          curveComplete: state.curveComplete,
          mint: seq.pda.mint.toBase58(),
        });
        sent.push({
          label,
          signature: "",
          status: outcome.status,
          reason: outcome.reason,
        });
        continue;
      }
    }
    try {
      const { signature } = await sendProtectedTx(
        connection,
        txs[i],
        seq.signersByTx[i],
        {
          attempts: 3,
          confirmTimeoutMs,
          label: `tx ${label}`,
          // The launch txs carry their own setComputeUnitPrice ix (added in
          // buildLaunchSequence); sendProtectedTx must NOT prepend a second.
          skipPriorityFeeIx: true,
          // The folded tx A is V0; sendProtectedTx needs the ALT to decompile
          // it and re-append the Sender tip. Legacy txs ignore this.
          lookupTable: seq.lookupTable ?? undefined,
        }
      );
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
      if (label === "migrate") {
        // A revert is accepted ONLY when the chain shows this mint's canonical
        // pool. Re-read the state; the error text is never the decision. When
        // the state read itself fails, fall through to the plain partial-state
        // throw (nothing is swallowed).
        const state = await readMigrateChainState(connection, seq.pda.mint).catch(
          () => null
        );
        if (state) {
          const outcome = classifyMigrateOutcome({
            sent: false,
            sendError: msg,
            poolKey: state.poolKey.toBase58(),
            poolExists: state.poolExists,
            poolBaseMintMatchesMint: state.poolBaseMintMatchesMint,
            curveComplete: state.curveComplete,
            mint: seq.pda.mint.toBase58(),
          });
          if (outcome.status === "already-migrated") {
            // Record the failed attempt's signature when the sender surfaced
            // one; the classification still comes from the chain state.
            const signature = signatureFromError(msg);
            if (signature && opts.onSignature) opts.onSignature(label, signature);
            sent.push({
              label,
              signature,
              status: outcome.status,
              reason: outcome.reason,
            });
            continue;
          }
          throw new Error(
            `${msg}${partial} | migrate evidence: pool ${state.poolKey.toBase58()} poolExists=${state.poolExists} poolBaseMintMatchesMint=${state.poolBaseMintMatchesMint} curve.complete=${state.curveComplete}; ${outcome.reason}`
          );
        }
      }
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

/** Reads a wallet's Token-2022 token balance for the launch mint (raw
 *  units). pump.fun mints are Token-2022 since the create_v2 migration, so
 *  the ATA is derived with TOKEN_2022_PROGRAM_ID. */
export async function walletTokenBalance(
  connection: Connection,
  wallet: PublicKey,
  mint: PublicKey
): Promise<bigint> {
  const ata = getAssociatedTokenAddressSync(mint, wallet, false, TOKEN_2022_PROGRAM_ID);
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

/** Lamports needed by each wallet to create its Token-2022 ATA on first buy.
 *  Token-2022 token accounts are 170 bytes (NOT 165 like legacy SPL). */
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
 *
 * The MPL account stores name/symbol/uri in FIXED-SIZE, NUL-PADDED fields
 * (name 32, symbol 10, uri 200 bytes): the length prefix is the string's
 * length, so decoding yields the padding too. Strip it here so no caller
 * ever renders or compares a NUL (the Trade header shows name ($TICKER)
 * straight from this read).
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
    const s = data
      .subarray(offset, offset + len)
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();
    offset += len;
    return s;
  };
  const name = readLenPrefixed();
  const symbol = readLenPrefixed();
  const uri = readLenPrefixed();
  if (name === null || symbol === null || uri === null) return null;
  return { name, symbol, uri };
}

/**
 * Reads the name / symbol / uri from a Token-2022 mint's in-mint token
 * metadata extension (create_v2 stores metadata IN THE MINT, not in a
 * Metaplex account). Returns null when the mint is not Token-2022, carries no
 * extension area, or has no metadata extension.
 *
 * Layout, measured on live mainnet pump.fun mints (scripts/probe-token2022-metadata.ts)
 * after the first version of this reader returned null for EVERY real mint:
 *   - Account: the 82-byte Mint struct, then padding out to ACCOUNT_SIZE
 *     (165), then the account-type byte (`AccountType.Mint` = 1), then the TLV
 *     extension area. spl-token's own unpackMint slices the TLV area the same
 *     way; handing getExtensionData the RAW account data matches nothing.
 *   - TokenMetadata payload: OptionalNonZeroPubkey update_authority (32 raw
 *     bytes, NO option tag; zeroed = none), then the mint (32 bytes), then
 *     name / symbol / uri as u32-LE-length-prefixed strings. Decoding the
 *     leading byte as an option flag shifts every field by one and fails.
 */
export async function readToken2022Metadata(
  connection: Connection,
  mint: PublicKey
): Promise<{ name: string; symbol: string; uri: string } | null> {
  const info = await connection.getAccountInfo(mint, "confirmed");
  if (!info) return null;
  // Legacy SPL mints have no extension area at all; their metadata, when they
  // have any, lives in a Metaplex account (readMetadataStrings).
  if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) return null;
  if (info.data.length <= ACCOUNT_SIZE) return null;
  if (info.data[ACCOUNT_SIZE] !== AccountType.Mint) return null;
  const tlv = info.data.subarray(ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE);
  const ext = getExtensionData(ExtensionType.TokenMetadata, tlv);
  if (!ext) return null;
  try {
    let offset = 0;
    offset += 32; // update_authority (OptionalNonZeroPubkey, no option tag)
    offset += 32; // mint
    const readStr = (): string | null => {
      if (offset + 4 > ext.length) return null;
      const len = ext.readUInt32LE(offset);
      offset += 4;
      if (offset + len > ext.length) return null;
      // Same NUL/whitespace normalize as the Metaplex reader: a name is
      // never allowed to reach the UI padded.
      const s = ext
        .subarray(offset, offset + len)
        .toString("utf8")
        .replace(/\0+$/, "")
        .trim();
      offset += len;
      return s;
    };
    const name = readStr();
    const symbol = readStr();
    const uri = readStr();
    if (name === null || symbol === null || uri === null) return null;
    return { name, symbol, uri };
  } catch {
    return null;
  }
}

export { LAMPORTS_PER_SOL };
