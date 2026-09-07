// Milestone M11: CLAIM CREATOR FEES (the "Claim Fees" button on the Launch
// card). Sweeps the connected creator's accrued pump.fun creator fees, the
// mechanism that actually pays out for the tokens this launchpad launches
// via pump.fun's NATIVE program (6EF8rrecth...):
//
//   1. Bonding-curve creator fee (0.30% of every curve trade), held in the
//      creator vault PDA (["creator-vault", creator]) under the Pump
//      program, drained via `collect_creator_fee_v2`. Hand-built here,
//      consistent with lib/pump.ts (no anchor Program, no IDL import).
//   2. PumpSwap coin creator fee (0.05%-0.95% of every AMM trade, only once
//      a coin graduates), held in the coin creator vault under the PumpSwap
//      AMM program, drained via `collect_coin_creator_fee` from the
//      installed @pump-fun/pump-swap-sdk (same SDK path as lib/migrate.ts /
//      lib/sell-all.ts).
//
// Both instructions are permissionless (anyone can trigger them; the fees
// flow to the creator's own accounts, not the signer). Both REVERT when the
// creator vault has been migrated to a sharing_config (fee sharing) - the
// launchpad never creates one, but the claim code surfaces that guard as a
// clear error instead of retrying (see isFeeSharingRevert).
//
// Verified sources (read before touching): pump-public-docs
// docs/instructions/COLLECT_CREATOR_FEE.md + idl/pump.json +
// idl/pump_amm.json (account layouts below mirror the docs table).
//
// ES2017 rules (project-wide, see lib/pump.ts): no bigint literals (use
// BigInt(...)); no Buffer.writeBigUInt64LE; every constant is a named
// export with its source stated.

import { Buffer } from "buffer";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  type AccountMeta,
} from "@solana/web3.js";
import { PUMP_AMM_SDK, OnlinePumpAmmSdk, PumpAmmSdk } from "@pump-fun/pump-swap-sdk";
import { sendProtectedTx } from "./bundle/protected-send";
import {
  CANONICAL_POOL_INDEX,
  WSOL_MINT,
  pumpSwapPoolPda,
} from "./migrate";
import {
  PUMP_EVENT_AUTHORITY,
  PUMP_PROGRAM_ID,
  pumpCreatorVaultPda,
  readPumpCurveState,
} from "./pump";

/* ------------------------------------------------------------------ */
/* collect_creator_fee_v2 (bonding curve, program 6EF8rrecth...)       */
/* ------------------------------------------------------------------ */

/** 8-byte anchor discriminator of `collect_creator_fee_v2`, the first 8
 *  bytes of sha256("global:collect_creator_fee_v2"): [207, 17, 138, 242, 4,
 *  34, 19, 56] = 0xcf118af204221338. Source: pump-public-docs idl/pump.json
 *  (`collect_creator_fee_v2` instruction). No args beyond the discriminator. */
export const PUMP_COLLECT_CREATOR_FEE_V2_DISCRIMINATOR: number[] = [
  207, 17, 138, 242, 4, 34, 19, 56, // 0xcf118af204221338
];

/** The account flags below are SENSIBLE defaults, NOT confirmed against the
 *  official IDL (it omits isWritable/isSigner): creator + creator_vault
 *  writable (creator is the recipient, creator_vault the drained source),
 *  event_authority writable (anchor event emission), everything else
 *  readonly except the two token accounts (writable per the docs table).
 *  CROSS-CHECK them against a live mainnet `collect_creator_fee_v2` tx
 *  (Solscan) before any mainnet deployment of this claim path. */
export function buildPumpCollectCreatorFeeV2Ix(opts: {
  /** The coin creator that receives the swept fees (the launchpad's
   *  connected creator wallet; must equal the curve's recorded creator). */
  creator: PublicKey;
}): TransactionInstruction {
  const { creator } = opts;
  const [creatorVault] = pumpCreatorVaultPda(creator);
  // For SOL-paired coins (this launchpad pairs only WSOL) the program does a
  // lamport transfer from creator_vault to creator and these two token
  // accounts are UNUSED (they may be uninitialized; still pass them,
  // derived correctly). Both are legacy-SPL ATAs of WSOL - the quote token
  // program is the LEGACY Tokenkeg..., NOT TOKEN_2022.
  const creatorTokenAccount = getAssociatedTokenAddressSync(
    WSOL_MINT,
    creator,
    false,
    TOKEN_PROGRAM_ID
  );
  const creatorVaultTokenAccount = getAssociatedTokenAddressSync(
    WSOL_MINT,
    creatorVault,
    true, // owner is the creator_vault PDA (off-curve)
    TOKEN_PROGRAM_ID
  );
  const keys: AccountMeta[] = [
    // Official IDL account order (pump-public-docs COLLECT_CREATOR_FEE.md):
    { pubkey: creator, isSigner: false, isWritable: true }, // 0 creator (recipient)
    { pubkey: creatorTokenAccount, isSigner: false, isWritable: true }, // 1 creator_token_account
    { pubkey: creatorVault, isSigner: false, isWritable: true }, // 2 creator_vault (source)
    { pubkey: creatorVaultTokenAccount, isSigner: false, isWritable: true }, // 3 creator_vault_token_account
    { pubkey: WSOL_MINT, isSigner: false, isWritable: false }, // 4 quote_mint
    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 5 quote_token_program (legacy SPL)
    { pubkey: ASSOCIATED_TOKEN_PROGRAM_ID, isSigner: false, isWritable: false }, // 6 associated_token_program
    { pubkey: SystemProgram.programId, isSigner: false, isWritable: false }, // 7 system_program
    { pubkey: PUMP_EVENT_AUTHORITY, isSigner: false, isWritable: true }, // 8 event_authority
    { pubkey: PUMP_PROGRAM_ID, isSigner: false, isWritable: false }, // 9 program
  ];
  return new TransactionInstruction({
    keys,
    programId: PUMP_PROGRAM_ID,
    data: Buffer.from(PUMP_COLLECT_CREATOR_FEE_V2_DISCRIMINATOR),
  });
}

/* ------------------------------------------------------------------ */
/* Sharing-config guard classification                                 */
/* ------------------------------------------------------------------ */

/** True when a raw tx error says a claim was rejected by the fee-sharing
 *  guard. Both collect_creator_fee_v2 (bonding curve) and
 *  collect_coin_creator_fee (PumpSwap AMM) revert with
 *  CreatorVaultMigratedToSharingConfig (6048) / CoinCreatorMigratedToSharingConfig
 *  (6047) once the creator's vault has been migrated to a sharing_config -
 *  codes + messages from the shared pump fee program IDL embedded in
 *  @pump-fun/pump-swap-sdk. Callers surface this as its own status line and
 *  must NOT silently retry (a retry cannot change the outcome). */
export function isFeeSharingRevert(raw: string): boolean {
  return /6047|6048|sharing.?config|migrated to sharing/i.test(raw);
}

/* ------------------------------------------------------------------ */
/* Claim entry point                                                   */
/* ------------------------------------------------------------------ */

/** One claim leg: either the lamports actually swept into the creator
 *  wallet (measured as the vault balance delta across the claim tx), or the
 *  short human reason the leg did not run (surfaced on the status line). */
export type CreatorFeeClaimLeg =
  | { claimedLamports: bigint }
  | { skipped: string };

export interface CreatorClaimReport {
  /** Connected creator the claim targeted (also the fee recipient). */
  creator: string;
  /** The tracked token mint (curve mint = PumpSwap base mint). */
  mint: string;
  /** Curve `complete` flag: whether the PumpSwap AMM leg was considered. */
  graduated: boolean;
  /** Bonding-curve leg outcome (collect_creator_fee_v2). */
  bond: CreatorFeeClaimLeg;
  /** PumpSwap AMM leg outcome (collect_coin_creator_fee). Null when the
   *  coin has not graduated (no AMM vault exists for it). */
  amm: CreatorFeeClaimLeg | null;
  /** Confirmed claim tx signature, or null when there was nothing to claim
   *  (no tx was sent). */
  signature: string | null;
  /** Total lamports swept into the creator wallet across executed legs. */
  totalClaimedLamports: bigint;
}

export interface ClaimCreatorFeesOptions {
  connection: Connection;
  /** The tracked token mint (curve mint = PumpSwap base mint). */
  mint: PublicKey;
  /** The connected creator wallet: must equal the curve's recorded creator
   *  (otherwise there is nothing of yours to claim). Signs and pays for the
   *  claim tx and receives the swept fees. */
  creator: Keypair;
}

/** Fallback rent-exempt floor (lamports for a 0-data account at Sep 2026
 *  rates) used only when the live getMinimumBalanceForRentExemption read
 *  fails; the live read is preferred because the floor drifts with the
 *  validator rent schedule. */
const RENT_EXEMPT_0_DATA_FALLBACK = 890_880;

async function rentExemptLamports(
  connection: Connection,
  dataLen: number
): Promise<bigint> {
  try {
    return BigInt(await connection.getMinimumBalanceForRentExemption(dataLen));
  } catch {
    return BigInt(RENT_EXEMPT_0_DATA_FALLBACK);
  }
}

/**
 * The CLAIM CREATOR FEES entry point. Sweeps the connected creator's
 * accrued pump.fun creator fees for the tracked mint:
 *
 *   - BONDING-CURVE LEG (always, when claimable): collect_creator_fee_v2,
 *     hand-built above. For SOL-paired coins the program transfers the
 *     creator vault's lamports above the rent-exempt floor into the creator
 *     wallet (the vault stays rent-exempt, per the public docs), so the
 *     claimable amount is measured as vault lamports minus that floor and
 *     the claimed amount as the vault delta across the tx.
 *   - AMM LEG (only when the coin graduated): collect_coin_creator_fee via
 *     the installed pump-swap-sdk (OnlinePumpAmmSdk for the read side,
 *     PumpAmmSdk for the instruction stream). Only proceeds when the
 *     graduated pool's recorded coin creator equals the connected creator
 *     and the coin creator vault holds a non-zero WSOL balance.
 *
 * Both applicable legs are packed into ONE tx, signed by the creator, and
 * sent through the shared protected-send path (lib/bundle/protected-send.ts,
 * the same sender the launch + trade txs use: plain sendAndConfirmWithRetry
 * on devnet, Helius Sender SWQOS priority fee + flat tip on mainnet). When
 * nothing is claimable in any leg the report is returned WITHOUT sending a
 * tx (signature null), so the UI can show "no accrued fees" instead of
 * burning a fee on an empty claim. A sharing-config revert is thrown as-is;
 * classify with isFeeSharingRevert and surface, never retry silently.
 */
export async function claimCreatorFees(
  opts: ClaimCreatorFeesOptions
): Promise<CreatorClaimReport> {
  const { connection, mint, creator } = opts;
  const creatorAddress = creator.publicKey;

  // The recorded creator comes from the pump.fun curve state (bonding-curve
  // PDA parse in lib/pump.ts). Claim only when the connected wallet equals
  // it: the vaults are keyed per creator, so a mismatch means the fees
  // belong to someone else.
  const read = await readPumpCurveState(connection, mint);
  if (read.kind === "missing") {
    throw new Error(
      `curve for mint ${mint.toBase58()} not found (not a pump.fun token?)`
    );
  }
  const curve = read.curve;
  if (!curve.creator.equals(creatorAddress)) {
    throw new Error(
      `connected wallet ${creatorAddress.toBase58()} is not this mint's recorded creator (${curve.creator.toBase58()})`
    );
  }
  const graduated = curve.complete;

  // BONDING-CURVE LEG read side: creator_vault = PDA(["creator-vault",
  // creator], PUMP_PROGRAM) holds the accrued SOL fees. Claimable = vault
  // lamports above the rent-exempt floor (the program leaves the vault
  // rent-exempt, per the public docs). A missing vault = no fees accrued
  // yet (and the ix would revert on a missing account, so skip instead).
  const [creatorVault] = pumpCreatorVaultPda(creatorAddress);
  const vaultInfo = await connection.getAccountInfo(creatorVault, "confirmed");
  let bondClaimable = BigInt(0);
  let bondSkip: string | null = null;
  if (!vaultInfo) {
    bondSkip = "creator vault not created yet (no accrued fees)";
  } else {
    const rent = await rentExemptLamports(connection, vaultInfo.data.length);
    const lamports = BigInt(vaultInfo.lamports);
    bondClaimable = lamports > rent ? lamports - rent : BigInt(0);
    if (bondClaimable <= BigInt(0)) {
      bondSkip = "creator vault holds no fees above the rent floor";
    }
  }

  // AMM LEG read side (only when the coin graduated): locate the PumpSwap
  // pool the curve auto-migrated to (same derivation as lib/migrate.ts /
  // sell-all.ts) and read its recorded coin creator. The AMM coin creator
  // vault (SDK coinCreatorVaultAtaPda under ["creator_vault", coin_creator])
  // normally equals the curve creator for this launchpad's own coins.
  const ammOnline = new OnlinePumpAmmSdk(connection);
  const ammSdk = new PumpAmmSdk();
  let ammLeg: CreatorFeeClaimLeg | null = null;
  let ammCoinCreator: PublicKey | null = null;
  let ammVaultBefore = BigInt(0);
  if (graduated) {
    const [poolKey] = pumpSwapPoolPda(
      CANONICAL_POOL_INDEX,
      curve.creator,
      mint,
      WSOL_MINT
    );
    const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
    if (!poolInfo) {
      ammLeg = { skipped: "PumpSwap pool not found for this mint (not migrated yet)" };
    } else {
      const pool = PUMP_AMM_SDK.decodePool(poolInfo);
      if (!pool.coinCreator.equals(creatorAddress)) {
        ammLeg = {
          skipped: "PumpSwap pool coin creator is not the connected wallet",
        };
      } else {
        ammVaultBefore = BigInt(
          (await ammOnline.getCoinCreatorVaultBalance(pool.coinCreator)).toString()
        );
        if (ammVaultBefore <= BigInt(0)) {
          ammLeg = { skipped: "no accrued PumpSwap creator fees" };
        } else {
          ammCoinCreator = pool.coinCreator;
        }
      }
    }
  }

  // Nothing claimable in any leg: report the skips without sending a tx.
  const ixs: TransactionInstruction[] = [];
  if (bondClaimable > BigInt(0)) {
    ixs.push(buildPumpCollectCreatorFeeV2Ix({ creator: creatorAddress }));
  }
  if (ammCoinCreator) {
    // The SDK wraps the WSOL side (creator vault ATA + creator WSOL ATA)
    // internally and closes the creator's WSOL ATA when the creator is the
    // payer, so the proceeds land as native SOL. Payer = coin creator.
    const state = await ammOnline.collectCoinCreatorFeeSolanaState(ammCoinCreator);
    const ammIxs = await ammSdk.collectCoinCreatorFee(state, ammCoinCreator);
    ixs.push(...ammIxs);
  }
  if (ixs.length === 0) {
    return {
      creator: creatorAddress.toBase58(),
      mint: mint.toBase58(),
      graduated,
      bond: bondSkip
        ? { skipped: bondSkip }
        : { skipped: "no accrued bonding-curve creator fees" },
      amm: ammLeg,
      signature: null,
      totalClaimedLamports: BigInt(0),
    };
  }

  // ONE tx for every applicable leg, signed + paid by the creator, through
  // the shared protected-send path (lib/bundle/protected-send.ts).
  const tx = new Transaction({ feePayer: creatorAddress });
  tx.add(...ixs);
  const { signature } = await sendProtectedTx(connection, tx, [creator], {
    label: "claim creator fees",
    confirmTimeoutMs: 90_000,
  });

  // Measure the claimed amounts as vault deltas across the confirmed tx.
  let bondLeg: CreatorFeeClaimLeg;
  if (bondClaimable > BigInt(0)) {
    let bondClaimed = bondClaimable; // fallback: the pre-tx estimate
    try {
      const afterInfo = await connection.getAccountInfo(creatorVault, "confirmed");
      const afterLamports = BigInt(afterInfo ? afterInfo.lamports : 0);
      const beforeLamports = BigInt(vaultInfo ? vaultInfo.lamports : 0);
      if (beforeLamports > afterLamports) {
        bondClaimed = beforeLamports - afterLamports;
      }
    } catch {
      // keep the estimate; the RPC re-read is best-effort
    }
    bondLeg = { claimedLamports: bondClaimed };
  } else {
    bondLeg = bondSkip
      ? { skipped: bondSkip }
      : { skipped: "no accrued bonding-curve creator fees" };
  }

  let ammClaimed = BigInt(0);
  if (ammCoinCreator) {
    try {
      const ammVaultAfter = BigInt(
        (await ammOnline.getCoinCreatorVaultBalance(ammCoinCreator)).toString()
      );
      ammClaimed =
        ammVaultBefore > ammVaultAfter
          ? ammVaultBefore - ammVaultAfter
          : ammVaultBefore;
      ammLeg = { claimedLamports: ammClaimed };
    } catch {
      // the SDK read is best-effort; report the pre-tx balance as claimed
      ammClaimed = ammVaultBefore;
      ammLeg = { claimedLamports: ammVaultBefore };
    }
  }

  return {
    creator: creatorAddress.toBase58(),
    mint: mint.toBase58(),
    graduated,
    bond: bondLeg,
    amm: ammLeg,
    signature,
    totalClaimedLamports:
      ("claimedLamports" in bondLeg ? bondLeg.claimedLamports : BigInt(0)) +
      ammClaimed,
  };
}
