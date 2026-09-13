// Offline regression test for D-1: the canonical PumpSwap pool PDA a migrated
// pump.fun token lives in is seeded by the CANONICAL POOL AUTHORITY
// (`pumpPoolAuthorityPda(mint) = PDA(["pool-authority", mint], pump)`), NOT by
// the curve's recorded creator. Seeding with `curve.creator` (the pre-fix
// code at lib/migrate.ts `lookupMigratedPool`) derives a pool that does not
// exist, which broke T2 sell-all, T3 AMM fee claim AND the roster's
// graduated-holder pricing.
//
// The four vectors below were read live from devnet/mainnet RPC (two clusters,
// four real tokens) and are frozen — do not re-derive them. Run offline:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pumpfun-pool-derivation.ts"

import { expect } from "chai";
import { PublicKey } from "@solana/web3.js";
import {
  canonicalMigratedPoolPda,
  pumpPoolAuthorityPda,
} from "../lib/migrate";

interface DerivationVector {
  cluster: "devnet" | "mainnet";
  mint: string;
  poolAuthority: string;
  pool: string;
}

const VECTORS: DerivationVector[] = [
  {
    cluster: "devnet",
    mint: "45biNEEiZGGFXmvd35FcbBDt2jWCUyGrimBJ4xE3pump",
    poolAuthority: "FsJgqzQ2zYSfYyiwfNREDj6HmmF5xTXsr2J6VpNuontm",
    pool: "5QYwbaEgcLYLo9aDHhQS86twrPi9i4RVKr3couE7ev4Z",
  },
  {
    cluster: "devnet",
    mint: "Ead7mBYMd4E5Fw9enSDdJFCSbaGXGkDwejFqYgw2pump",
    poolAuthority: "7FrbLic1FpnS9NtNVegNHnSK1L3GS88Lst4jRPAX3rA4",
    pool: "2V47V18iBrdToENctTzGvstRz4fxEX87LtA6VKLV5yoc",
  },
  {
    cluster: "mainnet",
    mint: "5Yotow29r4fxYaUUpWzt2CoWDLBpMoKcwzrZzu3fpump",
    poolAuthority: "FredBaoXmrjxgZgzeAeZfM1WCcEEN4KoyRzv9EAVhkD",
    pool: "5JF5zKcwLh1mmqnj49WdPw1AxkqRLmDpSX78n3oJuRTk",
  },
  {
    cluster: "mainnet",
    mint: "Ho2c6zj8o5vQGyFQYFBg4JC4k49vAA2tAcYVH2bNpump",
    poolAuthority: "2pTKEKzP1QVwLtq4x2JoN9s7JxDfrXkoHCx7htjmavUZ",
    pool: "5JFk3GPJBtd7PKiiHMi9UBTPFnze1j33zq5MF43UFw1B",
  },
];

describe("canonical PumpSwap pool derivation (D-1 regression)", () => {
  for (const v of VECTORS) {
    it(`derives the canonical pool for ${v.cluster} ${v.mint}`, () => {
      const mint = new PublicKey(v.mint);

      const [authority] = pumpPoolAuthorityPda(mint);
      expect(authority.toBase58()).to.equal(v.poolAuthority);

      const [pool, bump] = canonicalMigratedPoolPda(mint);
      expect(pool.toBase58()).to.equal(v.pool);
      expect(Number.isInteger(bump)).to.equal(true);
      expect(bump).to.be.greaterThan(-1);
      expect(bump).to.be.lessThan(256);
    });
  }

  it("rejects the pre-fix curve-creator seed for a known vector", () => {
    // The old code seeded ["pool", 0, curve.creator, mint, WSOL]. For the
    // devnet Ead7... vector that derived 4UJve32MHnCZPa6Ut8A2X77Y4otV1gZXZAkUvwLWedrG
    // (no such account). The canonical lookup must not equal that address.
    const mint = new PublicKey("Ead7mBYMd4E5Fw9enSDdJFCSbaGXGkDwejFqYgw2pump");
    const [canonical] = canonicalMigratedPoolPda(mint);
    expect(canonical.toBase58()).to.not.equal(
      "4UJve32MHnCZPa6Ut8A2X77Y4otV1gZXZAkUvwLWedrG"
    );
  });
});
