// Pump.fun shared address lookup table (ALT).
//
// The April-2026 pump.fun program upgrade made `create` a 14-account
// instruction and `buy`/`sell` 18/16-account instructions. The pre-flight
// sandbox (which simulates create + buy in ONE tx so the buy can run against
// the not-yet-created curve) therefore exceeds the 1232-byte legacy limit
// (~1246 bytes). The fix is a versioned (V0) tx with an address lookup table:
// every account that is CONSTANT across launches (system/token/ATA programs,
// rent sysvar, the pump.fun global + event authority + fee program + fee
// recipients + the constant PDAs) goes into a shared ALT and is referenced by
// a 1-byte index instead of a 32-byte pubkey. The per-launch accounts (mint,
// creator, buyers, and their mint/creator/buyer-derived PDAs) stay in the
// message as full pubkeys.
//
// The ALT is created once (cheap) and reused for every launch on the same
// cluster. It is only needed for SIMULATION — the real create/buy txs fit
// under 1232 bytes on their own and stay legacy.

import {
  AddressLookupTableAccount,
  AddressLookupTableProgram,
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
} from "@solana/web3.js";
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import {
  PUMP_BUYBACK_FEE_RECIPIENT,
  PUMP_EVENT_AUTHORITY,
  PUMP_FEE_PROGRAM_ID,
  PUMP_GLOBAL,
  PUMP_MAYHEM_PROGRAM_ID,
  PUMP_PROGRAM_ID,
  pumpFeeConfigPda,
  pumpGlobalVolumeAccumulatorPda,
  pumpMayhemGlobalParamsPda,
  pumpMayhemSolVaultPda,
  pumpMintAuthorityPda,
  resolvePumpFeeRecipient,
} from "../pump";

/** Every account that is identical across launches (safe to share in one ALT)
 *  EXCEPT the protocol fee recipient, which pump.fun rotates: pass the LIVE
 *  value from resolvePumpFeeRecipient so the sandbox always references the
 *  address the buy/sell instructions actually use. Order is irrelevant; the
 *  ALT is keyed by address. */
export function pumpLookupAccounts(feeRecipient: PublicKey): PublicKey[] {
  return [
    SystemProgram.programId,
    TOKEN_2022_PROGRAM_ID,
    ASSOCIATED_TOKEN_PROGRAM_ID,
    SYSVAR_RENT_PUBKEY,
    PUMP_GLOBAL,
    PUMP_MAYHEM_PROGRAM_ID,
    PUMP_EVENT_AUTHORITY,
    PUMP_PROGRAM_ID,
    PUMP_FEE_PROGRAM_ID,
    feeRecipient,
    PUMP_BUYBACK_FEE_RECIPIENT,
    pumpFeeConfigPda()[0],
    pumpMintAuthorityPda()[0],
    pumpGlobalVolumeAccumulatorPda()[0],
    pumpMayhemGlobalParamsPda()[0],
    pumpMayhemSolVaultPda()[0],
    ComputeBudgetProgram.programId,
  ];
}

/**
 * Returns a ready-to-use ALT. When `cachedAddress` names a live ALT it is
 * reused; otherwise a fresh ALT is created + extended in one tx and returned.
 * The payer (the creator) signs. The protocol fee recipient is resolved LIVE
 * (pump.fun rotates it), so a freshly created ALT always carries the address
 * the buy/sell instructions use. NOTE: a REUSED cached ALT created before a
 * rotation may lack the current recipient — that is safe (the sandbox then
 * writes the recipient as a full pubkey instead of a 1-byte index; it only
 * costs bytes, never correctness).
 */
export async function ensurePumpLookupTable(
  connection: Connection,
  payer: Keypair,
  cachedAddress?: string | null
): Promise<{ account: AddressLookupTableAccount; address: PublicKey }> {
  if (cachedAddress) {
    try {
      const existing = await connection.getAddressLookupTable(
        new PublicKey(cachedAddress)
      );
      if (existing.value) {
        return { account: existing.value, address: new PublicKey(cachedAddress) };
      }
    } catch {
      // fall through to (re)create
    }
  }

  const feeRecipient = await resolvePumpFeeRecipient(connection);

  const [createIx, address] = AddressLookupTableProgram.createLookupTable({
    authority: payer.publicKey,
    payer: payer.publicKey,
    recentSlot: await connection.getSlot("confirmed"),
  });
  const extendIx = AddressLookupTableProgram.extendLookupTable({
    payer: payer.publicKey,
    authority: payer.publicKey,
    lookupTable: address,
    addresses: pumpLookupAccounts(feeRecipient),
  });

  const latest = await connection.getLatestBlockhash("confirmed");
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: latest.blockhash,
    lastValidBlockHeight: latest.lastValidBlockHeight,
  });
  tx.add(createIx, extendIx);
  const sig = await connection.sendTransaction(tx, [payer], {
    skipPreflight: true,
  });
  await connection.confirmTransaction(
    { signature: sig, blockhash: latest.blockhash, lastValidBlockHeight: latest.lastValidBlockHeight },
    "confirmed"
  );

  const { value } = await connection.getAddressLookupTable(address);
  if (!value) throw new Error("lookup table missing after creation");
  return { account: value, address };
}

/** Builds an in-memory (NOT on-chain) ALT carrying the pump.fun constant
 *  accounts. Used to measure the size of a single-tx launch WITHOUT paying to
 *  create a real ALT (dry-run / tests). The address is a throwaway keypair
 *  pubkey; only the `addresses` list matters for size measurement. */
export function syntheticPumpLookupTable(
  feeRecipient: PublicKey,
  authority: PublicKey
): AddressLookupTableAccount {
  return new AddressLookupTableAccount({
    key: Keypair.generate().publicKey,
    state: {
      // u64::MAX = "never deactivated" (active table). Only the `addresses`
      // list matters for size measurement; the slot is a placeholder.
      deactivationSlot: BigInt("18446744073709551615"),
      authority,
      lastExtendedSlot: 0,
      lastExtendedSlotStartIndex: 0,
      addresses: pumpLookupAccounts(feeRecipient),
    },
  });
}
