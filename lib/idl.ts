// The Anchor client surface for the pumpfun program.
//
// The IDL at target/idl/pumpfun.json is the single source of truth for the
// client: `anchor build` regenerates it from programs/pumpfun/src/lib.rs, so
// when Milestone M3 lands (create() gains auto_migrate + lock_lp args and a
// `graduate` instruction is added) rebuilding regenerates this file and the
// client picks the new surface up automatically. Until then this module
// detects the pre-M3 shape and the launch panel degrades gracefully.
//
// The IDL is imported as JSON (resolveJsonModule) so the browser bundle
// carries the exact on-chain interface; no hand-written ABI mirrors exist.

import type { Idl } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import idlJson from "../target/idl/pumpfun.json";

/** The raw IDL JSON, typed loosely (anchor 1.x emits a newer spec than the
 *  @coral-xyz/anchor 0.31 `Idl` type models; the runtime shape is what
 *  matters and the M2 scripts already consume it as-is). */
export const PUMPFUN_IDL: Idl = idlJson as unknown as Idl;

/** The program id recorded in the IDL (devnet deploy). */
export const PUMPFUN_PROGRAM_ID: PublicKey = new PublicKey(
  (idlJson as { address: string }).address
);

export interface CreateMigrationCapability {
  /** The loaded IDL's create() accepts an auto_migrate arg. */
  autoMigrate: boolean;
  /** The loaded IDL's create() accepts a lock_lp arg. */
  lockLp: boolean;
  /** The loaded IDL declares a graduate instruction. */
  graduate: boolean;
}

/** Whether the loaded IDL's create() carries the M3 migration args. This is
 *  the capability gate: when false the DEPLOYED program cannot decode the
 *  new args and the launch panel must not send them (it disables the
 *  toggles with a "requires program upgrade" note instead of silently
 *  dropping them). */
export function createMigrationCapability(idl: Idl = PUMPFUN_IDL): CreateMigrationCapability {
  const instructions = (idl as unknown as { instructions?: { name?: string; args?: { name?: string }[] }[] })
    .instructions ?? [];
  const create = instructions.find((i) => i.name === "create");
  const argNames = (create?.args ?? []).map((a) => a.name ?? "");
  return {
    autoMigrate: argNames.includes("auto_migrate"),
    lockLp: argNames.includes("lock_lp"),
    graduate: instructions.some((i) => i.name === "graduate"),
  };
}

/** Short human label of the IDL capability, for the launch panel note. */
export function migrationCapabilityLabel(cap: CreateMigrationCapability): string {
  if (cap.autoMigrate && cap.lockLp) return "create() accepts auto_migrate + lock_lp (M3)";
  return "pre-M3 create(): auto_migrate + lock_lp args not in the loaded IDL";
}
