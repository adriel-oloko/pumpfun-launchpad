// Milestone M3 + M10: PumpSwap migration support on pump.fun's NATIVE
// program.
//
// M10: pump.fun auto-migrates its own curves at graduation (the buy that
// fills the curve migrates it to PumpSwap in the same instruction). The
// launchpad therefore NEVER calls a migrate instruction anymore —
// `migrateToPumpSwap` (the M3 client-driven migration of the CUSTOM program)
// is DELETED. What remains is the read side: deriving + looking up the
// PumpSwap pool a graduated pump.fun token migrated to (the pool PDA seeds
// from the CANONICAL pool authority, `PDA(["pool-authority", mint], pump)`,
// NOT from the curve's recorded creator), plus the generic PumpSwap SDK
// helpers (sendRawWithRetry, depositToPool) used by the M6 sell-all
// graduated leg.
//
// Exact SDK calls (verified in the Part A spike against a local validator
// with the PumpSwap program injected):
//   onlineSdk.createPoolSolanaState(index, creator, baseMint, quoteMint)
//   sdk.createPoolInstructions(createPoolSolanaState, baseIn, quoteIn)
//   onlineSdk.liquiditySolanaState(poolKey, user)
//   sdk.depositBaseInput(liquiditySolanaState, base, slippage)
//   sdk.depositInstructions(liquiditySolanaState, lpToken, slippage)
// PumpSwap itself and its WSOL quote mint are legacy SPL and UNCHANGED by
// the M10 swap. The BASE side is Token-2022 (every token pump.fun's active
// `create_v2` path mints is Token-2022).

import { BN } from "@coral-xyz/anchor";
import {
  GLOBAL_CONFIG_PDA,
  OnlinePumpAmmSdk,
  PUMP_AMM_EVENT_AUTHORITY_PDA,
  PumpAmmSdk,
  boostVaultAta,
  boostVaultAuthorityPda,
  canonicalPumpPoolPda as sdkCanonicalPumpPoolPda,
  pumpPoolAuthorityPda as sdkPumpPoolAuthorityPda,
} from "@pump-fun/pump-swap-sdk";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import {
  PUMP_EVENT_AUTHORITY,
  PUMP_GLOBAL,
  PUMP_PROGRAM_ID,
  pumpBondingCurveAta,
  pumpBondingCurvePda,
  readPumpCurveState,
} from "./pump";
import { solanaNetwork, type SolanaNetwork } from "./network";
import {
  isBlockhashExpiredError,
  isOnChainRevert,
  isSlippageRevert,
} from "./tx-errors";

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

/** Pool PDA: ["pool", index_u16_le, owner, baseMint, quoteMint] under the
 *  PumpSwap program, replicated from the SDK's poolPda(). `owner` is the
 *  CANONICAL pool authority, `pumpPoolAuthorityPda(mint)`
 *  (PDA(["pool-authority", mint], PUMP_PROGRAM_ID)) — NOT the curve's
 *  recorded creator (seeding with the creator derives a pool that does not
 *  exist; see `canonicalMigratedPoolPda`). */
export function pumpSwapPoolPda(
  index: number,
  owner: PublicKey,
  baseMint: PublicKey,
  quoteMint: PublicKey
): [PublicKey, number] {
  const indexBuf = Buffer.alloc(2);
  indexBuf.writeUInt16LE(index, 0);
  return PublicKey.findProgramAddressSync(
    [
      Buffer.from("pool"),
      indexBuf,
      owner.toBuffer(),
      baseMint.toBuffer(),
      quoteMint.toBuffer(),
    ],
    PUMP_AMM_PROGRAM_ID
  );
}

/** The canonical pump.fun pool authority for a mint:
 *  PDA(["pool-authority", mint], PUMP_PROGRAM_ID). This is the pool's seed
 *  owner on every canonical (index-0, WSOL-quoted) migrated pool, on BOTH
 *  clusters — not the curve creator. The address comes from the installed
 *  SDK's `pumpPoolAuthorityPda`; the bump comes from the same PDA derivation
 *  so callers can reuse it. */
export function pumpPoolAuthorityPda(mint: PublicKey): [PublicKey, number] {
  const address = sdkPumpPoolAuthorityPda(mint);
  const [, bump] = PublicKey.findProgramAddressSync(
    [Buffer.from("pool-authority"), mint.toBuffer()],
    PUMP_PROGRAM_ID
  );
  return [address, bump];
}

/** The canonical PumpSwap pool a migrated pump.fun token lives in:
 *  PDA(["pool", u16le(CANONICAL_POOL_INDEX), pumpPoolAuthorityPda(mint),
 *  mint, quoteMint], PUMP_AMM_PROGRAM_ID). Delegates the address to the
 *  installed SDK's `canonicalPumpPoolPda(mint, quoteMint)`, verified on four
 *  real tokens across both clusters. */
export function canonicalMigratedPoolPda(
  mint: PublicKey,
  quoteMint: PublicKey = WSOL_MINT,
  index: number = CANONICAL_POOL_INDEX
): [PublicKey, number] {
  if (index === CANONICAL_POOL_INDEX) {
    const address = sdkCanonicalPumpPoolPda(mint, quoteMint);
    const [authority] = pumpPoolAuthorityPda(mint);
    const [, bump] = pumpSwapPoolPda(index, authority, mint, quoteMint);
    return [address, bump];
  }
  const [authority] = pumpPoolAuthorityPda(mint);
  return pumpSwapPoolPda(index, authority, mint, quoteMint);
}

/** migrate discriminator (8 bytes, little-endian): the first 8 bytes of
 *  sha256("global:migrate") = 0x9beae792ec9ea21e. Verified against the
 *  deployed devnet program (a live Migrate tx carries exactly these bytes). */
export const PUMP_MIGRATE_DISCRIMINATOR: number[] = [
  155, 234, 231, 146, 236, 158, 162, 30,
];

/** migrate_v2 discriminator (8 bytes): the first 8 bytes of
 *  sha256("global:migrate_v2") = 0xbbcb121fceedfe29. From the official IDL
 *  (spec C3a) and confirmed on chain by both reference mainnet migrations.
 *  This is the instruction the launch sends; v1 stays exported for callers
 *  that still target the older 24/25-account layout. v1 and v2 accounts must
 *  never be mixed. */
export const PUMP_MIGRATE_V2_DISCRIMINATOR: number[] = [
  187, 203, 18, 31, 206, 237, 254, 41,
];

/** pump.fun's migration withdraw authority on DEVNET. It occupies account
 *  index 1 of the migrate instruction. On mainnet the program uses a
 *  different account, so callers must not pass this value on mainnet — use
 *  `withdrawAuthorityFor(solanaNetwork())` instead. Kept exported because
 *  other callers may import it. */
export const PUMP_DEVNET_WITHDRAW_AUTHORITY = new PublicKey(
  "5PXxuZkvftsg5CAGjv5LL5tEtvBRskdx1AAjxw8hK2Qx"
);

/** pump.fun's migration withdraw authority on MAINNET, measured read-only
 *  from two successful mainnet MigrateV2 transactions (spec C3a): it holds
 *  account index 1 and receives the curve's leftover SOL. */
export const PUMP_MAINNET_WITHDRAW_AUTHORITY = new PublicKey(
  "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
);

/** Pure cluster switch for the migrate instruction's `withdraw_authority`
 *  account (index 1): devnet -> `PUMP_DEVNET_WITHDRAW_AUTHORITY`, mainnet ->
 *  `PUMP_MAINNET_WITHDRAW_AUTHORITY`. Taking the network as an argument keeps
 *  the branch testable offline, without a live cluster read. */
export function withdrawAuthorityFor(network: SolanaNetwork): PublicKey {
  return network === "mainnet"
    ? PUMP_MAINNET_WITHDRAW_AUTHORITY
    : PUMP_DEVNET_WITHDRAW_AUTHORITY;
}

/**
 * Builds the pump.fun `migrate` instruction that actually creates the
 * canonical PumpSwap pool for a COMPLETED curve. On devnet the fill buy sets
 * `complete = 1` but does NOT create the pool (observed live: a completed
 * curve with no canonical pool account); the permissionless `migrate` call
 * does. The program creates the pool + ATAs + LP mint, moves the curve's
 * tokens and SOL into the pool, and burns the LP.
 *
 * v1 `migrate`, not `migrate_v2`: on the deployed devnet program v2 requires
 * extra remaining accounts the public IDL does not list (observed live:
 * NotEnoughRemainingAccounts = 6027), while v1's 25-account list matches a
 * live successful Migrate transaction exactly and needs no extras. v1 assumes
 * the base is Token-2022 (`token_2022_program`) and the quote is legacy WSOL
 * (`token_program`) — exactly this launchpad's shape.
 *
 * The caller signs as `user` (any funded wallet; the migration is
 * permissionless) and pays the pool/ATA rent.
 */
export function buildPumpMigrateIx(opts: {
  baseMint: PublicKey;
  user: PublicKey;
  quoteMint?: PublicKey;
}): TransactionInstruction {
  const { baseMint, user } = opts;
  const quoteMint = opts.quoteMint ?? WSOL_MINT;
  const [bondingCurve] = pumpBondingCurvePda(baseMint);
  const associatedBaseBondingCurve = pumpBondingCurveAta(baseMint);
  const [poolKey] = canonicalMigratedPoolPda(baseMint, quoteMint);
  const [poolAuthority] = pumpPoolAuthorityPda(baseMint);
  const poolAuthorityMintAccount = getAssociatedTokenAddressSync(
    baseMint,
    poolAuthority,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const poolAuthorityQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    poolAuthority,
    true,
    TOKEN_PROGRAM_ID
  );
  const [lpMint] = pumpSwapLpMintPda(poolKey);
  // The LP is minted to the POOL AUTHORITY's LP ATA and burned, locking the
  // pool; this is the account the IDL calls `user_pool_token_account`.
  const poolAuthorityLpAccount = getAssociatedTokenAddressSync(
    lpMint,
    poolAuthority,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const poolBaseTokenAccount = getAssociatedTokenAddressSync(
    baseMint,
    poolKey,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
    quoteMint,
    poolKey,
    true,
    TOKEN_PROGRAM_ID
  );
  // The deployed v1/v2 migrate requires the BOOST VAULT PAIR as the two
  // trailing remaining accounts (the public IDL omits them). The official
  // @pump-fun/pump-sdk binds them with boostVaultAuthorityPda(pool) and the
  // boost authority's quote ATA; without them the program reverts
  // NotEnoughRemainingAccounts (6027). Devnet pools are 300/301 bytes, so the
  // vault only ever needs the two remaining metas (no extend_account).
  const boostVaultAuthority = boostVaultAuthorityPda(poolKey);
  const boostVault = boostVaultAta(
    boostVaultAuthority,
    quoteMint,
    TOKEN_PROGRAM_ID
  );

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0 global
    // 1 withdraw_authority: cluster-correct (devnet or mainnet) via the pure
    // resolver; never the devnet constant on mainnet.
    {
      pubkey: withdrawAuthorityFor(solanaNetwork()),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: baseMint, isSigner: false, isWritable: false }, // 2 mint
    { pubkey: bondingCurve, isSigner: false, isWritable: true }, // 3 bonding_curve
    { pubkey: associatedBaseBondingCurve, isSigner: false, isWritable: true }, // 4 associated_bonding_curve
    { pubkey: user, isSigner: true, isWritable: true }, // 5 user
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 6 system_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 7 token_program (legacy WSOL)
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false }, // 8 pump_amm
    { pubkey: poolKey, isSigner: false, isWritable: true }, // 9 pool
    { pubkey: poolAuthority, isSigner: false, isWritable: true }, // 10 pool_authority
    { pubkey: poolAuthorityMintAccount, isSigner: false, isWritable: true }, // 11
    { pubkey: poolAuthorityQuoteAccount, isSigner: false, isWritable: true }, // 12
    { pubkey: GLOBAL_CONFIG_PDA, isSigner: false, isWritable: false }, // 13 amm_global_config
    { pubkey: quoteMint, isSigner: false, isWritable: false }, // 14 wsol_mint
    { pubkey: lpMint, isSigner: false, isWritable: true }, // 15 lp_mint
    { pubkey: poolAuthorityLpAccount, isSigner: false, isWritable: true }, // 16 user_pool_token_account
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true }, // 17
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true }, // 18
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 19 token_2022_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 20
    { pubkey: PUMP_AMM_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false }, // 21
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 22 event_authority
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 23 program
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // 24 rent
    // remaining accounts: the boost vault pair (see above).
    { pubkey: boostVaultAuthority, isSigner: false, isWritable: false }, // 25
    { pubkey: boostVault, isSigner: false, isWritable: true }, // 26
  ];
  return new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data: Buffer.from(PUMP_MIGRATE_DISCRIMINATOR),
  });
}

/**
 * Builds pump.fun's `migrate_v2` instruction — the instruction the launch
 * must send (spec C3/C3a). It declares the 27 IDL accounts in order, then the
 * 2 boost remaining accounts (boost vault authority + quote ATA) = 29 keys,
 * and carries no args (8 data bytes). The account order/flags are taken
 * position by position from the IDL-verified, chain-verified C3a table; the
 * captured Datadog row is asserted offline in tests/launch-fill-plan.ts.
 *
 * Index 1 is the cluster-correct `withdraw_authority` via the pure resolver
 * (`withdrawAuthorityFor(solanaNetwork())`), never the devnet constant on
 * mainnet. Index 6 (`associated_quote_bonding_curve`) is derived even though
 * a native-SOL curve has no such ATA (the reference passes a 0-lamport slot
 * there). The caller signs as `user` (the creator) and pays the rent.
 */
export function buildPumpMigrateV2Ix(opts: {
  baseMint: PublicKey;
  user: PublicKey;
  quoteMint?: PublicKey;
}): TransactionInstruction {
  const { baseMint, user } = opts;
  const quoteMint = opts.quoteMint ?? WSOL_MINT;
  const [bondingCurve] = pumpBondingCurvePda(baseMint);
  const associatedBaseBondingCurve = pumpBondingCurveAta(baseMint);
  const associatedQuoteBondingCurve = getAssociatedTokenAddressSync(
    quoteMint,
    bondingCurve,
    true,
    TOKEN_PROGRAM_ID
  );
  const [poolKey] = canonicalMigratedPoolPda(baseMint, quoteMint);
  const [poolAuthority] = pumpPoolAuthorityPda(baseMint);
  const poolAuthorityMintAccount = getAssociatedTokenAddressSync(
    baseMint,
    poolAuthority,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const poolAuthorityQuoteAccount = getAssociatedTokenAddressSync(
    quoteMint,
    poolAuthority,
    true,
    TOKEN_PROGRAM_ID
  );
  const [lpMint] = pumpSwapLpMintPda(poolKey);
  const poolAuthorityLpAccount = getAssociatedTokenAddressSync(
    lpMint,
    poolAuthority,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const poolBaseTokenAccount = getAssociatedTokenAddressSync(
    baseMint,
    poolKey,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const poolQuoteTokenAccount = getAssociatedTokenAddressSync(
    quoteMint,
    poolKey,
    true,
    TOKEN_PROGRAM_ID
  );
  // The 2 boost remaining accounts appended after the 27 IDL accounts (see
  // this file's v1 builder / the spec's section 5): without them the program
  // reverts NotEnoughRemainingAccounts (6027).
  const boostVaultAuthority = boostVaultAuthorityPda(poolKey);
  const boostVault = boostVaultAta(
    boostVaultAuthority,
    quoteMint,
    TOKEN_PROGRAM_ID
  );

  const keys = [
    { pubkey: PUMP_GLOBAL, isSigner: false, isWritable: false }, // 0 global
    // 1 withdraw_authority: cluster-correct (devnet or mainnet) via the pure
    // resolver; never the devnet constant on mainnet.
    {
      pubkey: withdrawAuthorityFor(solanaNetwork()),
      isSigner: false,
      isWritable: true,
    },
    { pubkey: baseMint, isSigner: false, isWritable: false }, // 2 base_mint
    { pubkey: quoteMint, isSigner: false, isWritable: false }, // 3 quote_mint
    { pubkey: bondingCurve, isSigner: false, isWritable: true }, // 4 bonding_curve
    { pubkey: associatedBaseBondingCurve, isSigner: false, isWritable: true }, // 5 associated_base_bonding_curve
    { pubkey: associatedQuoteBondingCurve, isSigner: false, isWritable: true }, // 6 associated_quote_bonding_curve
    { pubkey: user, isSigner: true, isWritable: true }, // 7 user
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 8 system_program
    { pubkey: PUMP_AMM_PROGRAM_ID, isSigner: false, isWritable: false }, // 9 pump_amm
    { pubkey: poolKey, isSigner: false, isWritable: true }, // 10 pool
    { pubkey: poolAuthority, isSigner: false, isWritable: true }, // 11 pool_authority
    { pubkey: poolAuthorityMintAccount, isSigner: false, isWritable: true }, // 12 pool_authority_mint_account
    { pubkey: poolAuthorityQuoteAccount, isSigner: false, isWritable: true }, // 13 pool_authority_quote_account
    { pubkey: GLOBAL_CONFIG_PDA, isSigner: false, isWritable: false }, // 14 amm_global_config
    { pubkey: lpMint, isSigner: false, isWritable: true }, // 15 lp_mint
    { pubkey: poolAuthorityLpAccount, isSigner: false, isWritable: true }, // 16 user_pool_token_account
    { pubkey: poolBaseTokenAccount, isSigner: false, isWritable: true }, // 17 pool_base_token_account
    { pubkey: poolQuoteTokenAccount, isSigner: false, isWritable: true }, // 18 pool_quote_token_account
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 19 base_token_program
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 20 quote_token_program
    { pubkey: TOKEN_2022_PROGRAM_ID, isSigner: false, isWritable: false }, // 21 token_2022_program
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 22 associated_token_program
    { pubkey: PUMP_AMM_EVENT_AUTHORITY_PDA, isSigner: false, isWritable: false }, // 23 pump_amm_event_authority
    { pubkey: SYSVAR_RENT_PUBKEY, isSigner: false, isWritable: false }, // 24 rent
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: false }, // 25 event_authority
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 26 program
    // remaining accounts: the boost vault pair.
    { pubkey: boostVaultAuthority, isSigner: false, isWritable: false }, // 27 boost_vault_authority
    { pubkey: boostVault, isSigner: false, isWritable: true }, // 28 boost_vault_ata
  ];
  return new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data: Buffer.from(PUMP_MIGRATE_V2_DISCRIMINATOR),
  });
}

/** LP mint PDA: ["pool_lp_mint", pool] under the PumpSwap program. */
export function pumpSwapLpMintPda(pool: PublicKey): [PublicKey, number] {
  return PublicKey.findProgramAddressSync(
    [Buffer.from("pool_lp_mint"), pool.toBuffer()],
    PUMP_AMM_PROGRAM_ID
  );
}

/** The PumpSwap pool a graduated mint migrated to, plus the pool's recorded
 *  coin creator. Derives the CANONICAL pool PDA (the pool authority seeds it,
 *  not the curve creator). When the pool account exists the `creator` field is
 *  the pool's decoded `coin_creator` (the account that receives AMM creator
 *  fees); when it does not exist yet, it falls back to the curve creator so
 *  callers can still show something meaningful before migration. The account
 *  only EXISTS after migration ran; this helper returns the derivation
 *  regardless so callers can distinguish "pool absent" from "not graduated". */
export interface MigratedPoolLookup {
  /** The pool's recorded coin creator when the pool account exists, else the
   *  pump curve creator. */
  creator: PublicKey;
  /** Curve `complete` flag (pool derivation is only meaningful after). */
  graduated: boolean;
  /** Derived canonical PumpSwap pool PDA for the mint. */
  poolKey: PublicKey;
  poolBump: number;
}

/** Offset of `coin_creator` in the PumpSwap pool account (after the 8-byte
 *  discriminator; pool layout table in the migration spec). */
const POOL_COIN_CREATOR_OFFSET = 211;
const POOL_COIN_CREATOR_END = 243;

/** Offset of `base_mint` in the PumpSwap pool account (after the 8-byte
 *  discriminator; pool layout table in the migration spec). Used to prove a
 *  pool discovered at the canonical PDA is THIS launch's pool and not another
 *  mint's. */
const POOL_BASE_MINT_OFFSET = 43;
const POOL_BASE_MINT_END = 75;

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
  const [poolKey, poolBump] = canonicalMigratedPoolPda(mint, WSOL_MINT, index);
  let creator = curve.creator;
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  if (poolInfo && poolInfo.data.length >= POOL_COIN_CREATOR_END) {
    creator = new PublicKey(
      poolInfo.data.subarray(POOL_COIN_CREATOR_OFFSET, POOL_COIN_CREATOR_END)
    );
  }
  return {
    creator,
    graduated: curve.complete,
    poolKey,
    poolBump,
  };
}

/** The migrate step's outcome. `landed` = send + confirm returned a
 *  signature; `already-migrated` = the send did not land but the chain shows
 *  THIS mint's canonical pool; `failed` = nothing on chain proves the
 *  migration happened. */
export type MigrateStatus = "landed" | "already-migrated" | "failed";

/** Everything `classifyMigrateOutcome` may look at. Only CHAIN STATE decides:
 *  `sendError` is diagnostic and is NEVER read to produce a success. */
export interface MigrateOutcomeInput {
  /** true when the send + confirm returned a signature */
  sent: boolean;
  /** the thrown message when sent is false; null otherwise. DIAGNOSTIC ONLY. */
  sendError: string | null;
  /** the canonical pool PDA (base58) the evidence is about. */
  poolKey: string;
  /** the canonical pool account is present on chain */
  poolExists: boolean;
  /** pool.data[43:75] == this launch's mint (only meaningful when poolExists) */
  poolBaseMintMatchesMint: boolean;
  /** curve.complete read AFTER the attempt */
  curveComplete: boolean;
  /** this launch's mint (base58), when known, for the reason text. */
  mint?: string;
}

export interface MigrateOutcome {
  status: MigrateStatus;
  /** names the DECIDING EVIDENCE, never an error code on its own */
  reason: string;
}

/**
 * Pure migrate-outcome classifier. THE DECISION IS CHAIN STATE, NOT ERROR
 * TEXT: `sendError` is carried for diagnostics and is never read here. The
 * decision table, in order:
 *
 *   sent                                            -> landed
 *   !sent && poolExists && baseMintMatch            -> already-migrated
 *   !sent && poolExists && !baseMintMatch           -> failed
 *   !sent && !poolExists                            -> failed
 *
 * A revert may only be accepted when the chain shows THIS mint's canonical
 * pool; an error code can never produce a success.
 */
export function classifyMigrateOutcome(
  i: MigrateOutcomeInput
): MigrateOutcome {
  if (i.sent) {
    return { status: "landed", reason: "send + confirm returned a signature" };
  }
  const curve = `curve.complete=${i.curveComplete ? 1 : 0}`;
  const mint = i.mint ? ` == ${i.mint}` : "";
  if (i.poolExists && i.poolBaseMintMatchesMint) {
    return {
      status: "already-migrated",
      reason: `canonical pool ${i.poolKey} exists with baseMint${mint} (${curve})`,
    };
  }
  if (i.poolExists) {
    return {
      status: "failed",
      reason: `canonical pool ${i.poolKey} exists but its base_mint does not match this launch mint${mint} (${curve})`,
    };
  }
  return {
    status: "failed",
    reason: `no canonical pool at ${i.poolKey} and ${curve}`,
  };
}

/** The chain facts the migrate classifier decides on, read in one pass. */
export interface MigrateChainState {
  /** Derived canonical PumpSwap pool PDA for the mint. */
  poolKey: PublicKey;
  /** The pool account exists on chain. */
  poolExists: boolean;
  /** The pool account's base_mint equals `mint` (false when absent/short). */
  poolBaseMintMatchesMint: boolean;
  /** Curve `complete` flag (false when the curve does not exist / read fails). */
  curveComplete: boolean;
}

/** Reads the migrate step's decision inputs: the canonical pool account (+ its
 *  base_mint at [43:75]) and the curve's `complete` flag. Reuses the shared
 *  PDA derivation and pool offsets; never hand-rolls a replacement. A pool
 *  account that exists but is too short to hold `base_mint` is reported as NOT
 *  matching, so it can never be mistaken for this launch's pool. */
export async function readMigrateChainState(
  connection: Connection,
  mint: PublicKey,
  index: number = CANONICAL_POOL_INDEX
): Promise<MigrateChainState> {
  const [poolKey] = canonicalMigratedPoolPda(mint, WSOL_MINT, index);
  const [curveRead, poolInfo] = await Promise.all([
    readPumpCurveState(connection, mint),
    connection.getAccountInfo(poolKey, "confirmed"),
  ]);
  const poolExists = poolInfo !== null;
  let poolBaseMintMatchesMint = false;
  if (poolInfo && poolInfo.data.length >= POOL_BASE_MINT_END) {
    poolBaseMintMatchesMint = new PublicKey(
      poolInfo.data.subarray(POOL_BASE_MINT_OFFSET, POOL_BASE_MINT_END)
    ).equals(mint);
  }
  return {
    poolKey,
    poolExists,
    poolBaseMintMatchesMint,
    curveComplete: curveRead.kind === "ok" && curveRead.curve.complete,
  };
}

/** Error thrown when a transaction was SENT and its confirmation reports an
 *  on-chain error. Carries the confirmed (failed) signature so callers can
 *  surface it instead of losing it — the gap that made the sell-all failures
 *  in SELL_ALL_CONCURRENCY_FIX.md section 2.1 require an on-chain scavenger
 *  hunt. It is still an `Error` with the same message the caller expects, so
 *  existing callers are unaffected. */
export class TxRevertError extends Error {
  /** The confirmed signature of the failed transaction attempt. */
  readonly signature: string;
  constructor(message: string, signature: string) {
    super(message);
    this.name = "TxRevertError";
    this.signature = signature;
  }
}

/** The confirmed signature carried by a failed tx error, when one exists.
 *  Retry loops use this to populate `lastFailedSignature` (R4). */
export function failedSignatureOf(e: unknown): string | undefined {
  if (e && typeof e === "object" && "signature" in e) {
    const s = (e as { signature?: unknown }).signature;
    if (typeof s === "string" && s.length > 0) return s;
  }
  return undefined;
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
        // R4: keep the signature of the failed attempt so the sell-all
        // report can surface it instead of discarding it.
        throw new TxRevertError(
          `transaction failed on chain: ${JSON.stringify(confirmed.value.err)}`,
          signature
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
      // ORDER IS LOAD-BEARING: a slippage revert ALSO matches
      // isOnChainRevert ("instructionerror"/"custom program error"). Check
      // the slippage class FIRST. Either branch stops this raw sender —
      // re-sending the SAME quote cannot change the price; the SELL-ALL
      // caller is the component that re-quotes and retries.
      if (isSlippageRevert(msg)) break;
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
