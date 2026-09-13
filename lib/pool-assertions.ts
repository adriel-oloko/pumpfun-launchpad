// Section 4 of docs/launch-flow-datadog-parity.md: the cluster-aware pool
// assertions every completed migration must satisfy.
//
// PURE: no RPC, no Connection, no signing — only PDA derivation and integer
// comparisons, so the SAME checks run in the browser
// (components/launch-panel.tsx), the devnet runner
// (scripts/devnet-migration-c.mjs) and the offline unit tests
// (tests/launch-fill-plan.ts).
//
// The measured reference table (2026-09-13) is encoded in CLUSTER_EXPECTED.
// The mainnet column is the Datadog / StonkHouse reference migrations; the
// devnet column is the rehearsal migration
// (mint 7d2zZF2gXJUe8HkdS4hAGFCr633kKozMksZ62udgoCEP,
//  pool 6TLFXvnypA7RFmdSH2k4M3GaeBBBerG2CvgYARAQwaxU).
//
// NOTE (spec deviation, documented in PLAN-ASSERTIONS.md): check 9 compares
// pool.virtualQuoteReserves against CLUSTER_EXPECTED[cluster].virtualQuoteReserves,
// NOT against `.boost`. The section 4 table lists them as distinct values on
// mainnet (17 584 505 288 vs 17 585 993 728) and section 1 fixes
// pool.virtualQuoteReserves at 17 584 505 288, so comparing to `.boost` would
// fail the real Datadog row.

import { PublicKey } from "@solana/web3.js";
import {
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { boostVaultAuthorityPda } from "@pump-fun/pump-swap-sdk";
import {
  WSOL_MINT,
  canonicalMigratedPoolPda,
  pumpPoolAuthorityPda,
} from "./migrate";

/** Pool base vault seed at migration: identical on both clusters (raw). */
export const BASE_VAULT_RAW: bigint = BigInt("206900000000000");

/** Tolerance on the pool's real quote vault at migration (assert 8), lamports. */
export const QUOTE_VAULT_TOLERANCE: bigint = BigInt("2000000");

export interface ClusterExpected {
  /** Net SOL the curve must receive for the fill, lamports. */
  fill: bigint;
  /** Canonical pool real quote vault at migration, lamports. */
  quoteVault: bigint;
  /** Boost vault balance at migration, lamports. */
  boost: bigint;
  /** Pool's recorded virtual quote reserve, lamports. */
  virtualQuoteReserves: bigint;
  /** Pool LP mint supply at migration, raw. */
  lpSupply: bigint;
}

/** The section 4 measured reference table, keyed by cluster. */
export const CLUSTER_EXPECTED: Record<"mainnet" | "devnet", ClusterExpected> = {
  mainnet: {
    fill: BigInt("85005359057"),
    quoteVault: BigInt("67407342208"),
    boost: BigInt("17585993728"),
    virtualQuoteReserves: BigInt("17584505288"),
    lpSupply: BigInt("4193388282604"),
  },
  devnet: {
    fill: BigInt("2833511969"),
    quoteVault: BigInt("2235361842"),
    boost: BigInt("583150126"),
    virtualQuoteReserves: BigInt("583150126"),
    lpSupply: BigInt("763642669171"),
  },
};

/** The decoded pool fields the assertions read (a subset of the PumpSwap SDK's
 *  `Pool`, with the BN fields widened to bigint). */
export interface MigratedPoolPoolFacts {
  /** Pool owner/authority (the SDK's `pool.creator`). */
  poolAuthority: PublicKey;
  baseMint: PublicKey;
  quoteMint: PublicKey;
  coinCreator: PublicKey;
  poolBaseTokenAccount: PublicKey;
  poolQuoteTokenAccount: PublicKey;
  virtualQuoteReserves: bigint;
  lpSupply: bigint;
  isMayhemMode: boolean;
  isCashbackCoin: boolean;
}

/** Everything the section 4 assertions need, gathered by the caller from the
 *  curve + canonical pool reads. Pure data: no keypair, no transaction. */
export interface MigratedPoolFacts {
  cluster: "mainnet" | "devnet";
  mint: PublicKey;
  /** The pump bonding curve's recorded creator. */
  curveCreator: PublicKey;
  /** The curve's `complete` flag. */
  curveComplete: boolean;
  pool: MigratedPoolPoolFacts;
  /** The pool base token account balance at migration (raw). */
  vaultBaseRaw: bigint;
  /** The pool quote token account balance at migration (lamports). */
  vaultQuoteLamports: bigint;
  /** The pool's boost vault authority PDA. */
  boostVaultAuthority: PublicKey;
  /** The boost vault quote-ATA balance READ AT MIGRATION (lamports). It is
   *  spent/drained later, so a later read is expected to be lower. */
  boostAtaLamports: bigint;
}

/** One assertion result: `ok:false` is a real failure UNLESS `actual` is the
 *  one-slot "not exercised (sequential sender)" sentinel (mainnet-only check). */
export interface PoolAssertion {
  name: string;
  expected: string;
  actual: string;
  ok: boolean;
}

/** The exact `actual` string a non-mainnet caller gets for check 3. Callers
 *  that must exit non-zero on failure treat this as informational, never as a
 *  pass and never as a hard failure. */
export const SLOT_CHECK_NOT_EXERCISED = "not exercised (sequential sender)";

/** The exact `actual` string a late caller gets for the migration-time checks
 *  (7, 8 and the balance half of 12). The vaults move and the boost ATA drains
 *  after migration, so a late read is not a pass and not a hard failure: it is
 *  simply not applicable. Callers that must exit non-zero treat this exactly
 *  like check 3's sentinel. */
export const LATE_READ_NOT_APPLICABLE = "not applicable (late read)";

/** Signed difference helper (bigint absolute value). */
function absBig(a: bigint, b: bigint): bigint {
  return a >= b ? a - b : b - a;
}

/**
 * Check 3 ("all four launch txs share one slot", MAINNET only) is the one
 * assertion a sequential devnet sender cannot exercise. `slotNumbers` is the
 * ordered slot of each launch tx (null entries allowed). When the caller
 * cannot supply them, this is reported as NOT ok with the explicit
 * "not exercised (sequential sender)" actual — never a fabricated pass.
 */
function oneSlotCheck(
  slotNumbers?: (number | null)[] | null
): PoolAssertion {
  const name = "all four launch txs share one slot";
  const expected = "one slot";
  if (!slotNumbers || slotNumbers.length === 0) {
    return { name, expected, actual: SLOT_CHECK_NOT_EXERCISED, ok: false };
  }
  const nums = slotNumbers.filter((s): s is number => typeof s === "number");
  if (nums.length !== slotNumbers.length) {
    return { name, expected, actual: SLOT_CHECK_NOT_EXERCISED, ok: false };
  }
  const first = nums[0];
  const allEqual = nums.every((s) => s === first);
  return {
    name,
    expected,
    actual: allEqual ? `slot ${first} (${nums.length} txs)` : `slots ${nums.join(",")}`,
    ok: allEqual,
  };
}

/**
 * Runs the section 4 checks over gathered facts and returns one entry per
 * check. Pure and deterministic: it never reads the chain and never throws on
 * a failed check (failures are `ok:false` entries). `opts.slots` feeds the
 * mainnet-only one-slot check; omit it on a sequential sender to get the
 * honest "not exercised" entry. `opts.atMigration` defaults to false: checks 7,
 * 8 and the balance half of 12 hold only immediately after migration, so a
 * late read reports "not applicable (late read)" instead of a pass or a
 * failure (the authority half of 12 keeps evaluating).
 */
export function assertMigratedPool(
  facts: MigratedPoolFacts,
  opts?: { slots?: (number | null)[]; atMigration?: boolean }
): PoolAssertion[] {
  const slots = opts?.slots;
  const atMigration = opts?.atMigration === true;
  const expected = CLUSTER_EXPECTED[facts.cluster];
  const [poolPda] = canonicalMigratedPoolPda(facts.mint);
  const [expectedPoolAuthority] = pumpPoolAuthorityPda(facts.mint);
  const expectedBaseAta = getAssociatedTokenAddressSync(
    facts.mint,
    poolPda,
    true,
    TOKEN_2022_PROGRAM_ID
  );
  const expectedQuoteAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    poolPda,
    true,
    TOKEN_PROGRAM_ID
  );
  const expectedBoostAuthority = boostVaultAuthorityPda(poolPda);

  const baseAtaOk = facts.pool.poolBaseTokenAccount.equals(expectedBaseAta);
  const quoteAtaOk = facts.pool.poolQuoteTokenAccount.equals(expectedQuoteAta);
  const boostAuthorityOk = facts.boostVaultAuthority.equals(
    expectedBoostAuthority
  );

  return [
    {
      name: "curve.complete == 1",
      expected: "true",
      actual: String(facts.curveComplete),
      ok: facts.curveComplete === true,
    },
    {
      name: "pool exists at canonicalMigratedPoolPda(mint)",
      expected: `${expectedBaseAta.toBase58()} / ${expectedQuoteAta.toBase58()}`,
      actual: `${facts.pool.poolBaseTokenAccount.toBase58()} / ${facts.pool.poolQuoteTokenAccount.toBase58()}`,
      ok: baseAtaOk && quoteAtaOk,
    },
    oneSlotCheck(slots),
    {
      name: "pool.baseMint == mint && pool.quoteMint == WSOL",
      expected: `${facts.mint.toBase58()} / ${WSOL_MINT.toBase58()}`,
      actual: `${facts.pool.baseMint.toBase58()} / ${facts.pool.quoteMint.toBase58()}`,
      ok:
        facts.pool.baseMint.equals(facts.mint) &&
        facts.pool.quoteMint.equals(WSOL_MINT),
    },
    {
      name: "pool.coinCreator == curve.creator",
      expected: facts.curveCreator.toBase58(),
      actual: facts.pool.coinCreator.toBase58(),
      ok: facts.pool.coinCreator.equals(facts.curveCreator),
    },
    {
      name: "pool.poolAuthority == pumpPoolAuthorityPda(mint)",
      expected: expectedPoolAuthority.toBase58(),
      actual: facts.pool.poolAuthority.toBase58(),
      ok: facts.pool.poolAuthority.equals(expectedPoolAuthority),
    },
    {
      name: "vaultBaseRaw == 206900000000000",
      expected: BASE_VAULT_RAW.toString(),
      actual: atMigration
        ? facts.vaultBaseRaw.toString()
        : LATE_READ_NOT_APPLICABLE,
      ok: atMigration && facts.vaultBaseRaw === BASE_VAULT_RAW,
    },
    {
      name: "vaultQuoteLamports ~= CLUSTER_EXPECTED.quoteVault",
      expected: `${expected.quoteVault} (+/- ${QUOTE_VAULT_TOLERANCE})`,
      actual: atMigration
        ? facts.vaultQuoteLamports.toString()
        : LATE_READ_NOT_APPLICABLE,
      ok:
        atMigration &&
        absBig(facts.vaultQuoteLamports, expected.quoteVault) <=
          QUOTE_VAULT_TOLERANCE,
    },
    {
      name: "pool.virtualQuoteReserves == CLUSTER_EXPECTED.virtualQuoteReserves",
      expected: expected.virtualQuoteReserves.toString(),
      actual: facts.pool.virtualQuoteReserves.toString(),
      ok: facts.pool.virtualQuoteReserves === expected.virtualQuoteReserves,
    },
    {
      name: "pool.lpSupply == CLUSTER_EXPECTED.lpSupply",
      expected: expected.lpSupply.toString(),
      actual: facts.pool.lpSupply.toString(),
      ok: facts.pool.lpSupply === expected.lpSupply,
    },
    {
      name: "!isMayhemMode && !isCashbackCoin",
      expected: "false / false",
      actual: `${facts.pool.isMayhemMode} / ${facts.pool.isCashbackCoin}`,
      ok: facts.pool.isMayhemMode === false && facts.pool.isCashbackCoin === false,
    },
    {
      name: "boostVaultAuthority == boostVaultAuthorityPda(pool) && boostAtaLamports == CLUSTER_EXPECTED.boost",
      expected: `${expectedBoostAuthority.toBase58()} / ${expected.boost}`,
      actual:
        !atMigration && boostAuthorityOk
          ? LATE_READ_NOT_APPLICABLE
          : `${facts.boostVaultAuthority.toBase58()} / ${facts.boostAtaLamports}`,
      ok: atMigration
        ? boostAuthorityOk && facts.boostAtaLamports === expected.boost
        : false,
    },
    {
      name: "pool.coinCreator == creator-fee claimer (curve creator)",
      expected: facts.curveCreator.toBase58(),
      actual: facts.pool.coinCreator.toBase58(),
      ok: facts.pool.coinCreator.equals(facts.curveCreator),
    },
  ];
}
