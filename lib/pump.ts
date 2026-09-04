// Milestone M10: the native pump.fun program surface.
//
// The launchpad used to drive a CUSTOM Anchor program (BTE4vdMy...) via its
// IDL. That program is unknown to every token indexer (DexScreener, Birdeye,
// Phantom, Jupiter, Gecko Terminal...), so tokens launched on it got NO
// listings, NO price chart, NO wallet visibility. This module is the client
// for pump.fun's OWN deployed program instead, so every token launched is a
// real pump.fun token: instantly indexed everywhere and carrying the `.pump`
// suffix in the ticker (the suffix is indexer-applied; NEVER append it to the
// symbol in create args).
//
// Everything here is built by hand — no anchor Program, no IDL import:
//   - constants (program ids, seeds, discriminators), verified against
//     pump.fun's public program + live mainnet (M10 prompt, do not re-derive)
//   - PDA derivations (bonding curve, creator vault, mint authority, fee
//     config, volume accumulators, metaplex metadata)
//   - the bonding-curve account layout parser (read to quote + detect
//     graduation via the `complete` flag)
//   - client-side quote math (pump.fun's buy takes TOKENS OUT, not SOL in)
//   - TransactionInstruction builders for create / buy / sell
//
// TOKEN PROGRAM GOTCHA: pump.fun's standard `create` mints are LEGACY SPL
// tokens (TOKEN_PROGRAM_ID), NOT Token-2022. Every ATA derivation in this
// module uses the legacy token program.
//
// ES2017 rules (project-wide): no bigint literals (use BigInt(...)); no
// Buffer.writeBigUInt64LE (missing in browser Buffer shims) — the 8 u64
// bytes are written in a loop.

import { Buffer } from "buffer";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  createAssociatedTokenAccountIdempotentInstruction,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionInstruction,
} from "@solana/web3.js";

/* ------------------------------------------------------------------ */
/* Verified pump.fun constants (M10 prompt table; do not guess)        */
/* ------------------------------------------------------------------ */

/** pump.fun's deployed program (mainnet + devnet). */
export const PUMP_PROGRAM_ID = new PublicKey(
  "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P"
);

/** pump.fun global state account. */
export const PUMP_GLOBAL = new PublicKey(
  "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf"
);

/** pump.fun protocol fee recipient. */
export const PUMP_FEE_RECIPIENT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV2fskvCwf8gCDbZ"
);

/** pump.fun event authority (seeds: ["event-authority"]). */
export const PUMP_EVENT_AUTHORITY = new PublicKey(
  "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7Hx6SgqR"
);

/** pump.fun fee program (creator + protocol fee split; the fee_config PDA
 *  lives under this program). */
export const PUMP_FEE_PROGRAM_ID = new PublicKey(
  "pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ"
);

/** MPL token metadata program (metadata PDAs are derived under it). */
export const PUMP_METAPLEX_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

/** Legacy SPL token program: pump.fun standard mints are LEGACY SPL, never
 *  Token-2022. Every ATA in the create/buy/sell path uses this program. */
export const PUMP_TOKEN_PROGRAM_ID: PublicKey = TOKEN_PROGRAM_ID;

/** Legacy SPL associated-token program. */
export const PUMP_ATA_PROGRAM_ID: PublicKey = ASSOCIATED_TOKEN_PROGRAM_ID;

/** Protocol fee, basis points (100 = 1%), applied on the input side. */
export const PUMP_FEE_BPS: bigint = BigInt(100);

/** Default slippage headroom in basis points (10%) for client-side quotes:
 *  generous enough for reserve drift between quote and execution AND for the
 *  on-chain fee program's tiered creator + protocol split (the client's
 *  guard only needs headroom; the program applies the real fee). */
export const PUMP_DEFAULT_SLIPPAGE_BPS: bigint = BigInt(1000);

/** Instruction discriminators (8 bytes, little-endian, pump.fun native
 *  program — NOT anchor discriminators). */
export const PUMP_CREATE_DISCRIMINATOR: number[] = [
  24, 30, 200, 40, 5, 28, 7, 119, // 0x181ec828051c0777
];
export const PUMP_BUY_DISCRIMINATOR: number[] = [
  102, 6, 61, 18, 1, 218, 235, 234, // 0x66063d1201daebea
];
export const PUMP_SELL_DISCRIMINATOR: number[] = [
  51, 230, 133, 164, 1, 127, 131, 173, // 0x33e685a4017f83ad
];

/* ------------------------------------------------------------------ */
/* Little helpers (ES2017-safe encoders)                               */
/* ------------------------------------------------------------------ */

/** Encodes a u64 as 8 little-endian bytes (loop write; no
 *  Buffer.writeBigUInt64LE — the browser Buffer shim lacks it). */
export function u64leBytes(v: bigint): Buffer {
  const b = Buffer.alloc(8);
  let x = v;
  for (let i = 0; i < 8; i++) {
    b[i] = Number(x & BigInt(0xff));
    x = x >> BigInt(8);
  }
  return b;
}

/** Borsh string: u32 LE byte length + utf8 bytes (the encoding pump.fun's
 *  native program uses for its String args). */
export function borshString(s: string): Buffer {
  const bytes = Buffer.from(s, "utf8");
  const len = Buffer.alloc(4);
  len.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([len, bytes]);
}

/* ------------------------------------------------------------------ */
/* PDA derivations (seeds confirmed in the M10 prompt)                 */
/* ------------------------------------------------------------------ */

const BONDING_CURVE_SEED = Buffer.from("bonding-curve");
const CREATOR_VAULT_SEED = Buffer.from("creator-vault");
const GLOBAL_VOLUME_SEED = Buffer.from("global_volume_accumulator");
const USER_VOLUME_SEED = Buffer.from("user_volume_accumulator");
const FEE_CONFIG_SEED = Buffer.from("fee_config");
const MINT_AUTHORITY_SEED = Buffer.from("mint-authority");
const METADATA_SEED = Buffer.from("metadata");

/** bonding_curve = PDA(["bonding-curve", mint], PUMP_PROGRAM). */
export function pumpBondingCurvePda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [BONDING_CURVE_SEED, mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

/** creator_vault = PDA(["creator-vault", creator], PUMP_PROGRAM): the
 *  account receiving the creator's fee share on every buy/sell. */
export function pumpCreatorVaultPda(creator: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [CREATOR_VAULT_SEED, creator.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

/** global_volume_accumulator = PDA(["global_volume_accumulator"],
 *  PUMP_PROGRAM). */
export function pumpGlobalVolumeAccumulatorPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [GLOBAL_VOLUME_SEED],
    PUMP_PROGRAM_ID
  );
}

/** user_volume_accumulator = PDA(["user_volume_accumulator", user],
 *  PUMP_PROGRAM). */
export function pumpUserVolumeAccumulatorPda(
  user: PublicKey
): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [USER_VOLUME_SEED, user.toBuffer()],
    PUMP_PROGRAM_ID
  );
}

/** fee_config = PDA(["fee_config"], FEE_PROGRAM). */
export function pumpFeeConfigPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [FEE_CONFIG_SEED],
    PUMP_FEE_PROGRAM_ID
  );
}

/** mint_authority = PDA(["mint-authority"], PUMP_PROGRAM). GLOBAL — the seed
 *  carries NO mint: the program mints the initial supply through this PDA at
 *  create and it never appears in buy/sell. */
export function pumpMintAuthorityPda(): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [MINT_AUTHORITY_SEED],
    PUMP_PROGRAM_ID
  );
}

/** metadata = PDA(["metadata", MPL_TOKEN_METADATA, mint],
 *  MPL_TOKEN_METADATA). */
export function pumpMetadataPda(mint: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [METADATA_SEED, PUMP_METAPLEX_PROGRAM_ID.toBuffer(), mint.toBuffer()],
    PUMP_METAPLEX_PROGRAM_ID
  );
}

/** The bonding curve's own legacy-SPL ATA of the mint (owner = the curve
 *  PDA, so allowOwnerOffCurve = true). */
export function pumpBondingCurveAta(mint: PublicKey): PublicKey {
  const [bondingCurve] = pumpBondingCurvePda(mint);
  return getAssociatedTokenAddressSync(
    mint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID
  );
}

/** A user's legacy-SPL ATA of the mint. */
export function pumpUserAta(mint: PublicKey, user: PublicKey): PublicKey {
  return getAssociatedTokenAddressSync(mint, user, false, TOKEN_PROGRAM_ID);
}

/* ------------------------------------------------------------------ */
/* Bonding-curve state (read to quote + detect graduation)             */
/* ------------------------------------------------------------------ */

/** Decoded pump.fun bonding-curve state (account layout after the 8-byte
 *  discriminator, offsets confirmed in the M10 prompt):
 *
 *   offset 8  u64  virtual_token_reserves
 *   offset 16 u64  virtual_sol_reserves
 *   offset 24 u64  real_token_reserves
 *   offset 32 u64  real_sol_reserves
 *   offset 40 u64  token_total_supply
 *   offset 48 u8   complete (1 = graduated, migrated to PumpSwap)
 *   offset 49 [32] creator pubkey
 */
export interface PumpCurveState {
  virtualTokenReserves: bigint;
  virtualSolReserves: bigint;
  realTokenReserves: bigint;
  realSolReserves: bigint;
  tokenTotalSupply: bigint;
  /** 1 = the curve graduated and migrated to PumpSwap (buy/sell revert). */
  complete: boolean;
  /** The recorded creator (set at create; the PumpSwap pool creator once
   *  graduated; feeds the creator_vault account on buys/sells). */
  creator: PublicKey;
}

/** Fetch result that distinguishes "mint has no curve" from RPC errors. */
export type PumpCurveRead =
  | { kind: "ok"; curve: PumpCurveState }
  | { kind: "missing" };

/** Fetches + parses the pump.fun bonding-curve account for a mint.
 *  Returns { kind: "missing" } when the account does not exist or is too
 *  short to decode (a random mint with no curve behind the token address).
 *  RPC/transport errors THROW (the caller retries instead of treating a
 *  transient failure as a dead curve). */
export async function readPumpCurveState(
  connection: Connection,
  mint: PublicKey
): Promise<PumpCurveRead> {
  const [bondingCurve] = pumpBondingCurvePda(mint);
  const info = await connection.getAccountInfo(bondingCurve, "confirmed");
  if (!info) return { kind: "missing" };
  const data = info.data;
  if (data.length < 49 + 32) return { kind: "missing" };
  const readU64 = (offset: number): bigint => {
    let v = BigInt(0);
    for (let i = 7; i >= 0; i--) {
      v = (v << BigInt(8)) | BigInt(data[offset + i]);
    }
    return v;
  };
  return {
    kind: "ok",
    curve: {
      virtualTokenReserves: readU64(8),
      virtualSolReserves: readU64(16),
      realTokenReserves: readU64(24),
      realSolReserves: readU64(32),
      tokenTotalSupply: readU64(40),
      complete: data[48] === 1,
      creator: new PublicKey(data.subarray(49, 49 + 32)),
    },
  };
}

/* ------------------------------------------------------------------ */
/* Client-side quote math (constant product + fee; buy quotes TOKENS    */
/* OUT because pump.fun's buy takes tokens_out, not SOL in)            */
/* ------------------------------------------------------------------ */

export interface PumpBuyQuote {
  /** Token amount handed to the buy instruction (raw units). */
  tokensOut: bigint;
  /** SOL the buyer is willing to spend at most, including slippage
   *  headroom (lamports). */
  maxSolCost: bigint;
  /** Simulated virtual sol reserve AFTER this buy (chain quotes). */
  nextVirtualSolReserves: bigint;
  /** Simulated virtual token reserve AFTER this buy (chain quotes). */
  nextVirtualTokenReserves: bigint;
}

/**
 * Quotes a pump.fun buy from a SOL amount against the curve's VIRTUAL
 * reserves (the exact numbers the program quotes on). Fee = 100 bps (1%)
 * charged on the SOL input; the fee never enters the curve. `maxSolCost`
 * carries the slippage headroom so the tx survives reserve drift and the
 * on-chain fee program's real (possibly tiered) split.
 */
export function quotePumpBuy(opts: {
  solInLamports: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  feeBps?: bigint;
  slippageBps?: bigint;
}): PumpBuyQuote {
  const {
    solInLamports,
    virtualSolReserves,
    virtualTokenReserves,
    feeBps = PUMP_FEE_BPS,
    slippageBps = PUMP_DEFAULT_SLIPPAGE_BPS,
  } = opts;
  if (solInLamports <= BigInt(0)) {
    throw new Error(`buy amount must be positive, got ${solInLamports}`);
  }
  const solAfterFee =
    (solInLamports * (BigInt(10_000) - feeBps)) / BigInt(10_000);
  const tokensOut =
    (solAfterFee * virtualTokenReserves) /
    (virtualSolReserves + solAfterFee);
  const maxSolCost =
    (solInLamports * (BigInt(10_000) + slippageBps)) / BigInt(10_000);
  return {
    tokensOut,
    maxSolCost,
    nextVirtualSolReserves: virtualSolReserves + solAfterFee,
    nextVirtualTokenReserves: virtualTokenReserves - tokensOut,
  };
}

export interface PumpSellQuote {
  /** Gross SOL out before the fee (lamports). */
  grossSolOut: bigint;
  /** Net SOL out after the fee (lamports). */
  netSolOut: bigint;
  /** min_sol_output handed to the sell instruction (net under the slippage
   *  band). */
  minSolOutput: bigint;
}

/**
 * Quotes a pump.fun sell from a token amount against the curve's VIRTUAL
 * reserves. Fee = 100 bps on the SOL output. `min_sol_output` sits slippage
 * BELOW the net quote, so it is a floor, never a price target.
 */
export function quotePumpSell(opts: {
  tokensIn: bigint;
  virtualSolReserves: bigint;
  virtualTokenReserves: bigint;
  feeBps?: bigint;
  slippageBps?: bigint;
}): PumpSellQuote {
  const {
    tokensIn,
    virtualSolReserves,
    virtualTokenReserves,
    feeBps = PUMP_FEE_BPS,
    slippageBps = PUMP_DEFAULT_SLIPPAGE_BPS,
  } = opts;
  if (tokensIn <= BigInt(0)) {
    throw new Error(`sell amount must be positive, got ${tokensIn}`);
  }
  if (virtualTokenReserves <= BigInt(0) || virtualSolReserves <= BigInt(0)) {
    throw new Error(`curve reserves not positive for a sell quote`);
  }
  const grossSolOut =
    (tokensIn * virtualSolReserves) / (virtualTokenReserves + tokensIn);
  const netSolOut =
    (grossSolOut * (BigInt(10_000) - feeBps)) / BigInt(10_000);
  const minSolOutput =
    (netSolOut * (BigInt(10_000) - slippageBps)) / BigInt(10_000);
  return { grossSolOut, netSolOut, minSolOutput };
}

/* ------------------------------------------------------------------ */
/* Instruction builders (hand-built TransactionInstructions)            */
/* ------------------------------------------------------------------ */

/**
 * Builds the pump.fun `create` instruction: a fresh legacy-SPL mint (the
 * caller's `mintKeypair` signs the tx alongside the creator), name/symbol/
 * uri as the ONLY args (never append `.pump` to the symbol — indexers add
 * the suffix because the token is on pump.fun's program). The account order
 * below is the official IDL order (mint, mint_authority, bonding_curve,
 * associated_bonding_curve, global, mpl_token_metadata, metadata,
 * user/creator, system_program, associated_token_program, rent,
 * event_authority, program).
 */
export function buildPumpCreateIx(opts: {
  creator: PublicKey;
  mint: PublicKey;
  name: string;
  symbol: string;
  uri: string;
}): TransactionInstruction {
  const { creator, mint, name, symbol, uri } = opts;
  if (Buffer.byteLength(name, "utf8") > 32) {
    throw new Error(`name too long: ${name}`);
  }
  if (Buffer.byteLength(symbol, "utf8") > 10) {
    throw new Error(`symbol too long: ${symbol}`);
  }
  if (Buffer.byteLength(uri, "utf8") > 200) {
    throw new Error(`uri too long: ${uri}`);
  }
  const [bondingCurve] = pumpBondingCurvePda(mint);
  const [mintAuthority] = pumpMintAuthorityPda();
  const [metadata] = pumpMetadataPda(mint);
  const associatedBondingCurve = pumpBondingCurveAta(mint);
  const keys = [
    { pubkey: mint, isSigner: true, isWritable: true },
    { pubkey: mintAuthority, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_METAPLEX_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: metadata, isSigner: false, isWritable: true },
    { pubkey: creator, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: PUMP_ATA_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([
    Buffer.from(PUMP_CREATE_DISCRIMINATOR),
    borshString(name),
    borshString(symbol),
    borshString(uri),
  ]);
  return new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data,
  });
}

/**
 * Builds the pump.fun `buy` instruction pair for one buyer:
 *   [createAssociatedTokenAccountIdempotent (buyer ATA, legacy SPL), buy]
 * The ATA-create is harmless when the ATA already exists (the proven SDKs do
 * exactly this). buy data = discriminator ++ u64le(tokens_out) ++
 * u64le(max_sol_cost). The account order below is the official current buy
 * layout (16 accounts, incl. the fee-program leg: creator_vault, volume
 * accumulators, fee_config, fee_program).
 */
export function buildPumpBuyIx(opts: {
  mint: PublicKey;
  buyer: PublicKey;
  /** The curve's recorded creator (from readPumpCurveState; the creator
   *  vault + the creator fee leg are derived from it). */
  creator: PublicKey;
  tokensOut: bigint;
  maxSolCost: bigint;
}): TransactionInstruction[] {
  const { mint, buyer, creator, tokensOut, maxSolCost } = opts;
  const [bondingCurve] = pumpBondingCurvePda(mint);
  const associatedBondingCurve = pumpBondingCurveAta(mint);
  const associatedUser = pumpUserAta(mint, buyer);
  const [creatorVault] = pumpCreatorVaultPda(creator);
  const [globalVolumeAccumulator] = pumpGlobalVolumeAccumulatorPda();
  const [userVolumeAccumulator] = pumpUserVolumeAccumulatorPda(buyer);
  const [feeConfig] = pumpFeeConfigPda();

  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    buyer,
    associatedUser,
    buyer,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedUser, isSigner: false, isWritable: true },
    { pubkey: buyer, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: globalVolumeAccumulator, isSigner: false, isWritable: false },
    { pubkey: userVolumeAccumulator, isSigner: false, isWritable: true },
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([
    Buffer.from(PUMP_BUY_DISCRIMINATOR),
    u64leBytes(tokensOut),
    u64leBytes(maxSolCost),
  ]);
  const buyIx = new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data,
  });
  return [ataIx, buyIx];
}

/**
 * Builds the pump.fun `sell` instruction pair for one seller:
 *   [createAssociatedTokenAccountIdempotent (seller ATA, legacy SPL), sell]
 * sell data = discriminator ++ u64le(tokens_in) ++ u64le(min_sol_output).
 * The account order below is the official current sell layout (14 accounts,
 * incl. the fee-program leg: creator_vault, fee_config, fee_program).
 */
export function buildPumpSellIx(opts: {
  mint: PublicKey;
  seller: PublicKey;
  /** The curve's recorded creator (from readPumpCurveState); feeds the
   *  creator_vault account. */
  creator: PublicKey;
  tokensIn: bigint;
  minSolOutput: bigint;
}): TransactionInstruction[] {
  const { mint, seller, creator, tokensIn, minSolOutput } = opts;
  const [bondingCurve] = pumpBondingCurvePda(mint);
  const associatedBondingCurve = pumpBondingCurveAta(mint);
  const associatedUser = pumpUserAta(mint, seller);
  const [creatorVault] = pumpCreatorVaultPda(creator);
  const [feeConfig] = pumpFeeConfigPda();

  const ataIx = createAssociatedTokenAccountIdempotentInstruction(
    seller,
    associatedUser,
    seller,
    mint,
    TOKEN_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID
  );

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_RECIPIENT, isSigner: false, isWritable: true },
    { pubkey: mint, isSigner: false, isWritable: false },
    { pubkey: bondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedBondingCurve, isSigner: false, isWritable: true },
    { pubkey: associatedUser, isSigner: false, isWritable: true },
    { pubkey: seller, isSigner: true, isWritable: true },
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    { pubkey: creatorVault, isSigner: false, isWritable: true },
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false },
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false },
    { pubkey: feeConfig, isSigner: false, isWritable: false },
    { pubkey: PUMP_FEE_PROGRAM_ID, isSigner: false, isWritable: false },
  ];
  const data = Buffer.concat([
    Buffer.from(PUMP_SELL_DISCRIMINATOR),
    u64leBytes(tokensIn),
    u64leBytes(minSolOutput),
  ]);
  const sellIx = new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data,
  });
  return [ataIx, sellIx];
}
