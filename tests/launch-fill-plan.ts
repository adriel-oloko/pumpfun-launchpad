// Offline regression tests for docs/launch-flow-datadog-parity.md C1 (the
// fill-sized chunk plan) and C2 (wallet-paid fill txs).
//
// No network, no keys, no Connection: only the pure quote math in lib/pump.ts
// and the instruction packing in lib/bundle/launch.ts. The curve numbers are
// the spec's mainnet/devnet references (do not re-derive):
//   mainnet vSol=30000000000, vTok=1073000000000000, rTok=793100000000000
//   devnet  vSol=1000000000
//   fill net  85005359057 / 2833511969 lamports
//   fill gross 86081376261 / 2869379210 lamports
//
// Run:
//   npx ts-mocha tests/launch-fill-plan.ts
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/launch-fill-plan.ts"
//
// The first form is the repo's gate. ts-mocha defaults to ./tsconfig.json,
// whose "module": "esnext" makes ts-node load the test through Node's native
// ESM resolver, which cannot resolve the lib's extensionless relative imports
// (the two existing tests are documented to pass `-p ./tsconfig.test.json`).
// Re-registering ts-node onto the CommonJS test project here, and requiring
// the lib through createRequire, makes the literal gate command work without
// editing tsconfig.json / adding a .mocharc.

import { expect } from "chai";
import { createRequire } from "module";

const nodeRequire = createRequire(
  process.cwd() + "/tests/launch-fill-plan.ts"
);
const tsNode = nodeRequire("ts-node") as {
  register: (opts: { project: string; transpileOnly: boolean }) => void;
};
tsNode.register({ project: "./tsconfig.test.json", transpileOnly: true });

const web3 = nodeRequire("@solana/web3.js") as typeof import("@solana/web3.js");
const { Keypair, PublicKey } = web3;
const pump = nodeRequire("../lib/pump.ts") as typeof import("../lib/pump");
const launch = nodeRequire(
  "../lib/bundle/launch.ts"
) as typeof import("../lib/bundle/launch");
const lookup = nodeRequire(
  "../lib/bundle/lookup.ts"
) as typeof import("../lib/bundle/lookup");
const migrate = nodeRequire(
  "../lib/migrate.ts"
) as typeof import("../lib/migrate");
const network = nodeRequire(
  "../lib/network.ts"
) as typeof import("../lib/network");
const poolAssertions = nodeRequire(
  "../lib/pool-assertions.ts"
) as typeof import("../lib/pool-assertions");
const sellFold = nodeRequire(
  "../lib/sell-fold.ts"
) as typeof import("../lib/sell-fold");
const sellAll = nodeRequire(
  "../lib/sell-all.ts"
) as typeof import("../lib/sell-all");

const ZERO = BigInt(0);
const VTOK = BigInt("1073000000000000");
const RTOK = BigInt("793100000000000");
const MAINNET_VSOL = BigInt("30000000000");
const DEVNET_VSOL = BigInt("1000000000");
const MAINNET_FILL_NET = BigInt("85005359057");
const MAINNET_SOL_IN = BigInt("86081376261");
const DEVNET_FILL_NET = BigInt("2833511969");
const DEVNET_SOL_IN = BigInt("2869379210");
/** ceil(solIn / n), the spec's per-wallet gross split. */
function perWallet(solIn: bigint, n: number): bigint {
  return (solIn + BigInt(n) - BigInt(1)) / BigInt(n);
}

function buysFor(count: number, budget: bigint) {
  return Array.from({ length: count }, () => ({
    wallet: Keypair.generate(),
    solInLamports: budget,
  }));
}

function mainnetSeed() {
  return {
    virtualSolReserves: MAINNET_VSOL,
    virtualTokenReserves: VTOK,
    realTokenReserves: RTOK,
  };
}

/** The synthetic launch ALT, carrying the same fallback fee recipient the
 *  fake connection's null global read resolves to. */
function syntheticAlt(authority: PublicKey) {
  return lookup.syntheticPumpLookupTable(
    pump.pumpFeeRecipientFallback(),
    authority
  );
}

describe("(a) chunk quoting is monotonic; the final buy takes rTok", () => {
  it("quotePumpChunk cost strictly increases with tokens_out", () => {
    const curve = {
      virtualSolReserves: MAINNET_VSOL,
      virtualTokenReserves: VTOK,
      realTokenReserves: RTOK,
    };
    const small = pump.quotePumpChunk(curve, BigInt("1000000000000"), ZERO);
    const large = pump.quotePumpChunk(curve, BigInt("2000000000000"), ZERO);
    expect(large.costLamports > small.costLamports).to.equal(true);
    expect(large.maxSolCost > small.maxSolCost).to.equal(true);
  });

  it("quoteLaunchBuys forces the final buy to take realTokenReserves", () => {
    const seed = mainnetSeed();
    const quotes = launch.quoteLaunchBuys(
      buysFor(5, perWallet(MAINNET_SOL_IN, 5)),
      ZERO,
      seed
    );
    const firstSum = quotes
      .slice(0, -1)
      .reduce((a, q) => a + q.tokensOut, ZERO);
    const last = quotes[quotes.length - 1];
    expect(last.tokensOut).to.equal(RTOK - firstSum);
    const total = quotes.reduce((a, q) => a + q.tokensOut, ZERO);
    expect(total).to.equal(RTOK);
  });
});

describe("(b) the planned mainnet plan nets at least the reference fill", () => {
  it("5 equal gross deposits net >= 85005359057 lamports", () => {
    const quotes = launch.quoteLaunchBuys(
      buysFor(5, perWallet(MAINNET_SOL_IN, 5)),
      ZERO,
      mainnetSeed()
    );
    const netSum = quotes.reduce((a, q) => a + q.costLamports, ZERO);
    expect(netSum >= MAINNET_FILL_NET).to.equal(true);
  });

  it("the fill quote itself is the reference floor", () => {
    const fill = pump.quotePumpFill(
      {
        virtualSolReserves: MAINNET_VSOL,
        virtualTokenReserves: VTOK,
        realTokenReserves: RTOK,
      },
      ZERO
    );
    expect(fill.costLamports).to.equal(MAINNET_FILL_NET);
    expect(fill.maxSolCost).to.equal(MAINNET_SOL_IN);
    expect(fill.tokensOut).to.equal(RTOK);
  });
});

describe("(c) the per-buy floor shortfall still graduates via the last buy", () => {
  it("5 equal devnet deposits land short, and the last buy takes the remainder", () => {
    const seed = {
      virtualSolReserves: DEVNET_VSOL,
      virtualTokenReserves: VTOK,
      realTokenReserves: RTOK,
    };
    const quotes = launch.quoteLaunchBuys(
      buysFor(5, perWallet(DEVNET_SOL_IN, 5)),
      ZERO,
      seed
    );
    const firstSum = quotes
      .slice(0, -1)
      .reduce((a, q) => a + q.tokensOut, ZERO);
    const last = quotes[quotes.length - 1];
    // The 125 bps floor leaves the earlier chunks short of the fill...
    expect(firstSum < RTOK).to.equal(true);
    // ...so the graduating buy requests exactly the remainder and the curve
    // completes (`quoteLaunchBuys` never clamps a chunk; it forces the last).
    expect(last.tokensOut).to.equal(RTOK - firstSum);
    expect(firstSum + last.tokensOut).to.equal(RTOK);
    expect(pump.quotePumpFill(seed, ZERO).tokensOut).to.equal(RTOK);
    const netSum = quotes.reduce((a, q) => a + q.costLamports, ZERO);
    expect(netSum >= DEVNET_FILL_NET).to.equal(true);
  });
});

describe("(d) the curve is a hard cap, never clamped", () => {
  it("tokens_out == realTokenReserves + 1 throws", () => {
    const curve = {
      virtualSolReserves: MAINNET_VSOL,
      virtualTokenReserves: VTOK,
      realTokenReserves: RTOK,
    };
    expect(() =>
      pump.quotePumpChunk(curve, RTOK + BigInt(1), ZERO)
    ).to.throw(/hard cap/i);
  });

  it("tokens_out == realTokenReserves is accepted unchanged", () => {
    const curve = {
      virtualSolReserves: MAINNET_VSOL,
      virtualTokenReserves: VTOK,
      realTokenReserves: RTOK,
    };
    const q = pump.quotePumpChunk(curve, RTOK, ZERO);
    expect(q.tokensOut).to.equal(RTOK);
  });
});

describe("(C2) fill txs are paid by the pair's first wallet", () => {
  it("packBuyTxs uses the pair's first wallet as fee payer, never the creator", () => {
    const creator = Keypair.generate();
    const buys = buysFor(4, perWallet(MAINNET_SOL_IN, 4));
    const quotes = launch.quoteLaunchBuys(buys, ZERO, mainnetSeed());
    const pda = launch.deriveLaunchPdas(Keypair.generate().publicKey);
    const buyTxs = launch.packBuyTxs({
      creator,
      pda,
      buys,
      quotes,
      feeRecipient: PublicKey.default,
      blockhash: "11111111111111111111111111111111",
      maxBuyTxBytes: 1150,
      tipReserveBytes: 90,
    });
    expect(buyTxs.length).to.equal(2);
    for (const bt of buyTxs) {
      expect(bt.wallets.length).to.equal(2);
      expect(bt.tx.feePayer?.toBase58()).to.equal(
        bt.wallets[0].publicKey.toBase58()
      );
      expect(
        bt.wallets.some(
          (w) => w.publicKey.toBase58() === creator.publicKey.toBase58()
        )
      ).to.equal(false);
      // The creator is not required to sign a fill tx: signing with only the
      // pair must succeed (a missing creator signature would make serialize
      // throw).
      bt.tx.sign(...bt.wallets);
      expect(bt.tx.signatures.length).to.equal(2);
      expect(bt.tx.serialize().length > 0).to.equal(true);
    }
  });
});

describe("(C3) cluster-correct migrate withdraw authority", () => {
  it("withdrawAuthorityFor('devnet') is the measured devnet authority", () => {
    expect(migrate.withdrawAuthorityFor("devnet").toBase58()).to.equal(
      "5PXxuZkvftsg5CAGjv5LL5tEtvBRskdx1AAjxw8hK2Qx"
    );
  });

  it("withdrawAuthorityFor('mainnet') is the measured mainnet authority", () => {
    expect(migrate.withdrawAuthorityFor("mainnet").toBase58()).to.equal(
      "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg"
    );
  });

  it("buildPumpMigrateIx puts the resolver's authority at account index 1", () => {
    const ix = migrate.buildPumpMigrateIx({
      baseMint: Keypair.generate().publicKey,
      user: Keypair.generate().publicKey,
    });
    // Whatever cluster this test runs on, index 1 must be the resolver's
    // value for that cluster — never the devnet constant on mainnet.
    expect(ix.keys[1].pubkey.toBase58()).to.equal(
      migrate.withdrawAuthorityFor(network.solanaNetwork()).toBase58()
    );
  });
});

describe("(C3) buildPumpMigrateV2Ix matches the captured Datadog migration", () => {
  // Raw addresses from docs/launch-flow-datadog-parity.md C3a, position by
  // position as sent by the successful Datadog migrate_v2. Index 1 is the
  // cluster-specific withdraw authority, asserted through the resolver below,
  // not as a literal (it differs between clusters).
  const DATADOG_MIGRATION: string[] = [
    "4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf", // 0 global
    "39azUYFWPz3VHgKCf3VChUwbpURdCHRxjWVowf5jUJjg", // 1 withdraw_authority
    "2G8jCXX6HCTtXmZ8ngS2Z3qs6z2BJzLhdJt7YNsgpump", // 2 base_mint
    "So11111111111111111111111111111111111111112", // 3 quote_mint
    "2NBq1kemNNnKNgi5FgTs8yHNkdRUMMcH1w64PW7uwKzY", // 4 bonding_curve
    "CQ3dU94HDykjtCEGhcqnyPDrTu3YRPT5fmSVdVUq5rxw", // 5 associated_base_bonding_curve
    "7pWduEEMGPipy1mqKM4jqXN9wHXSJC1acpXofBp8f586", // 6 associated_quote_bonding_curve
    "2ga4pVmMwe5aUKUtKnomj8mvG9rj7DivF8Q3MKWEMLyw", // 7 user
    "11111111111111111111111111111111", // 8 system_program
    "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", // 9 pump_amm
    "3WkN2cs4rCQthRxnrgqmKgYT28SQJWoqSYzp8eRmPR1D", // 10 pool
    "DxDMoct8QJtwHNprFSsd84wRKizxE3JnYn2ADn81UT2r", // 11 pool_authority
    "7tdSkm2ACkjJ2KWmi2TbcrjKtTTwNY7bsCJvCkvDXmEb", // 12 pool_authority_mint_account
    "3MdRuksXE1n8A5bxhwVLzCuadCWpjnrkmr5hMgbNsux2", // 13 pool_authority_quote_account
    "ADyA8hdefvWN2dbGGWFotbzWxrAvLW83WG6QCVXvJKqw", // 14 amm_global_config
    "BcjG8ZPqqik1LX1gvFKnVH3bTtV2DCq8NF1H9Lt6ojCF", // 15 lp_mint
    "AqrTtJ1EscF6MMTVogR3wnrLY3CLZ6k4YK9CgriW4kiT", // 16 user_pool_token_account
    "Dn6VJUM3ebTy25z1JW1iMLLo9JvVLQ9dZ7fJP3i4mrQF", // 17 pool_base_token_account
    "6v9Ed4TKEm6Kh2D5MKHYp2e9pBtaRFSamkZBg7CyC9YZ", // 18 pool_quote_token_account
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // 19 base_token_program
    "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", // 20 quote_token_program
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", // 21 token_2022_program
    "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL", // 22 associated_token_program
    "GS4CU59F31iL7aR2Q8zVS8DRrcRnXX1yjQ66TqNVQnaR", // 23 pump_amm_event_authority
    "SysvarRent111111111111111111111111111111111", // 24 rent
    "Ce6TQqeHC9p8KetsN6JsjHK7UTZk7nasjjnr7XxXp9F1", // 25 event_authority
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", // 26 program
    "C2gXtzdP4c9FfKBHubunoARnP2rzPdda7p4jUKpcEpQ6", // 27 boost_vault_authority
    "5e2HDNNWsDtB8ziYUsSY5nrRtVsrU2dtkVum7mwb39Xn", // 28 boost_vault_ata
  ];

  function buildV2() {
    return migrate.buildPumpMigrateV2Ix({
      baseMint: new PublicKey("2G8jCXX6HCTtXmZ8ngS2Z3qs6z2BJzLhdJt7YNsgpump"),
      user: new PublicKey("2ga4pVmMwe5aUKUtKnomj8mvG9rj7DivF8Q3MKWEMLyw"),
      quoteMint: migrate.WSOL_MINT,
    });
  }

  it("carries the migrate_v2 discriminator and exactly 29 accounts", () => {
    const ix = buildV2();
    expect([...ix.data]).to.deep.equal(migrate.PUMP_MIGRATE_V2_DISCRIMINATOR);
    expect([...ix.data]).to.deep.equal([187, 203, 18, 31, 206, 237, 254, 41]);
    expect(ix.keys.length).to.equal(29);
  });

  it("matches the captured Datadog row at every position except index 1", () => {
    const ix = buildV2();
    for (let i = 0; i < DATADOG_MIGRATION.length; i++) {
      if (i === 1) continue;
      expect(ix.keys[i].pubkey.toBase58()).to.equal(DATADOG_MIGRATION[i]);
    }
  });

  it("index 1 is the cluster-correct resolver value, not the literal", () => {
    const ix = buildV2();
    expect(ix.keys[1].pubkey.toBase58()).to.equal(
      migrate.withdrawAuthorityFor(network.solanaNetwork()).toBase58()
    );
  });
});

type MigratedPoolFacts = import("../lib/pool-assertions").MigratedPoolFacts;

describe("(e) section 4 pool assertions (mainnet + devnet reference rows)", () => {
  const WSOL = migrate.WSOL_MINT;

  // Datadog (mainnet reference, spec section 1 + C3a). Every address is the
  // captured row; the pool ATAs are C3a indices 17/18.
  function datadogFacts(): MigratedPoolFacts {
    const mint = new PublicKey("2G8jCXX6HCTtXmZ8ngS2Z3qs6z2BJzLhdJt7YNsgpump");
    const creator = new PublicKey(
      "2ga4pVmMwe5aUKUtKnomj8mvG9rj7DivF8Q3MKWEMLyw"
    );
    return {
      cluster: "mainnet",
      mint,
      curveCreator: creator,
      curveComplete: true,
      pool: {
        poolAuthority: new PublicKey(
          "DxDMoct8QJtwHNprFSsd84wRKizxE3JnYn2ADn81UT2r"
        ),
        baseMint: mint,
        quoteMint: WSOL,
        coinCreator: creator,
        poolBaseTokenAccount: new PublicKey(
          "Dn6VJUM3ebTy25z1JW1iMLLo9JvVLQ9dZ7fJP3i4mrQF"
        ),
        poolQuoteTokenAccount: new PublicKey(
          "6v9Ed4TKEm6Kh2D5MKHYp2e9pBtaRFSamkZBg7CyC9YZ"
        ),
        virtualQuoteReserves: BigInt("17584505288"),
        lpSupply: BigInt("4193388282604"),
        isMayhemMode: false,
        isCashbackCoin: false,
      },
      vaultBaseRaw: BigInt("206900000000000"),
      vaultQuoteLamports: BigInt("67407342208"),
      boostVaultAuthority: new PublicKey(
        "C2gXtzdP4c9FfKBHubunoARnP2rzPdda7p4jUKpcEpQ6"
      ),
      boostAtaLamports: BigInt("17585993728"),
    };
  }

  // Devnet rehearsal (spec section 4): mint 7d2zZF2g…, pool 6TLFXvny…,
  // creator J91gUm8T…. The pool ATAs / boost authority are the derived
  // canonical addresses measured by the rehearsal run.
  function devnetFacts(): MigratedPoolFacts {
    const mint = new PublicKey(
      "7d2zZF2gXJUe8HkdS4hAGFCr633kKozMksZ62udgoCEP"
    );
    const creator = new PublicKey(
      "J91gUm8TmP4n3Y7ZpkX825QMyPWgJ74o9ib97ct47DDy"
    );
    return {
      cluster: "devnet",
      mint,
      curveCreator: creator,
      curveComplete: true,
      pool: {
        poolAuthority: new PublicKey(
          "28zTmj3LB7TNHHSrWkL62QzrUYXpNRi276HfxoPXiPJo"
        ),
        baseMint: mint,
        quoteMint: WSOL,
        coinCreator: creator,
        poolBaseTokenAccount: new PublicKey(
          "2PMr3VQPQU49YJVpziKMUDTC6gKfm6bYdGU7rFuVbPBV"
        ),
        poolQuoteTokenAccount: new PublicKey(
          "5G8p5fQ1kUSBMz3iiAJ7ihS7n7tNamoKk1eKZoLLYjRs"
        ),
        virtualQuoteReserves: BigInt("583150126"),
        lpSupply: BigInt("763642669171"),
        isMayhemMode: false,
        isCashbackCoin: false,
      },
      vaultBaseRaw: BigInt("206900000000000"),
      vaultQuoteLamports: BigInt("2235361842"),
      boostVaultAuthority: new PublicKey(
        "4g3v9SPRQd8bvXamPXcJ77b6SFrN7tBWYdpCxeNctHxy"
      ),
      boostAtaLamports: BigInt("583150126"),
    };
  }

  // Datadog slot 446446487: the four reference txs all landed together.
  const DATADOG_SLOTS = [446446487, 446446487, 446446487, 446446487];

  it("mainnet reference row passes all 13 checks (slots supplied)", () => {
    const checks = poolAssertions.assertMigratedPool(datadogFacts(), {
      slots: DATADOG_SLOTS,
      atMigration: true,
    });
    expect(checks.length).to.equal(13);
    expect(checks.filter((c) => !c.ok)).to.deep.equal([]);
  });

  it("devnet rehearsal row passes every check except the unexercised slot check", () => {
    const checks = poolAssertions.assertMigratedPool(devnetFacts(), {
      atMigration: true,
    });
    expect(checks.length).to.equal(13);
    const slot = checks.find((c) => c.name.includes("one slot"));
    expect(slot).to.not.equal(undefined);
    if (slot) {
      expect(slot.ok).to.equal(false);
      expect(slot.actual).to.equal("not exercised (sequential sender)");
    }
    expect(checks.filter((c) => !c.ok && c !== slot)).to.deep.equal([]);
  });

  it("exactly one check flips for a single perturbed value", () => {
    const facts = datadogFacts();
    // vaultQuoteLamports is read by check 8 only; push it past the 2M
    // tolerance so exactly that one entry flips.
    facts.vaultQuoteLamports = facts.vaultQuoteLamports + BigInt("3000000");
    const checks = poolAssertions.assertMigratedPool(facts, {
      slots: DATADOG_SLOTS,
      atMigration: true,
    });
    const failed = checks.filter((c) => !c.ok);
    expect(failed.length).to.equal(1);
    expect(failed[0].name).to.contain("vaultQuoteLamports");
  });

  it("late read makes checks 7, 8 and 12 exactly not-applicable, rest evaluate", () => {
    const checks = poolAssertions.assertMigratedPool(datadogFacts(), {
      atMigration: false,
    });
    expect(checks.length).to.equal(13);
    const check7 = checks.find((c) => c.name.startsWith("vaultBaseRaw"));
    const check8 = checks.find((c) =>
      c.name.startsWith("vaultQuoteLamports")
    );
    const check12 = checks.find((c) =>
      c.name.startsWith("boostVaultAuthority")
    );
    for (const c of [check7, check8, check12]) {
      expect(c).to.not.equal(undefined);
      expect(c?.ok).to.equal(false);
      expect(c?.actual).to.equal("not applicable (late read)");
    }
    // Check 3 is still the unexercised slot sentinel, and every other check
    // (1, 2, 4, 5, 6, 9, 10, 11, 13) still evaluates and passes.
    const slot = checks.find((c) => c.name.includes("one slot"));
    expect(slot?.actual).to.equal("not exercised (sequential sender)");
    const exempt = new Set([
      check7?.name,
      check8?.name,
      check12?.name,
      slot?.name,
    ]);
    for (const c of checks) {
      if (exempt.has(c.name)) continue;
      expect(c.ok).to.equal(true);
    }
  });

  it("the authority half of check 12 still evaluates on a late read", () => {
    const facts = datadogFacts();
    facts.boostVaultAuthority = Keypair.generate().publicKey;
    const check12 = poolAssertions
      .assertMigratedPool(facts, { atMigration: false })
      .find((c) => c.name.startsWith("boostVaultAuthority"));
    expect(check12).to.not.equal(undefined);
    expect(check12?.ok).to.equal(false);
    expect(check12?.actual).to.not.equal("not applicable (late read)");
  });
});

// STAGE 2 (PLAN-SELLALL-STAGE2.md): FOLDED FLOORS.
//
// The point of the fold is that a wallet's floor reflects the price impact its
// PREDECESSORS cause, which the run-level snapshot cannot see. These tests pin
// the three properties that make it safe, in the order they matter:
//
//   1. CONSERVATIVE: every folded floor is at or below the floor a snapshot
//      quote would have produced. The callers take min(folded, fresh), so this
//      property is what guarantees the change can only ever LOOSEN a floor.
//   2. MONOTONE: the expected proceeds strictly decrease down the sell order.
//   3. BOUNDED: the folded expectation is never better than reality allows,
//      because a missing/late seller can only mean less impact than planned.
describe("stage 2: folded sell floors", () => {
  const BAND = BigInt(500); // the 5 percent band the sell paths use
  const wallets = (sizes: string[]) =>
    sizes.map((tokens, i) => ({
      address: `wallet-${i}`,
      tokens: BigInt(tokens),
    }));

  it("curve fold: a single wallet matches the plain quote exactly", () => {
    const tokens = BigInt("22155565838919");
    const steps = sellFold.foldCurveSells({
      balances: [{ address: "solo", tokens }],
      virtualSolReserves: DEVNET_VSOL,
      virtualTokenReserves: VTOK,
      slippageBps: BAND,
    });
    const plain = pump.quotePumpSell({
      tokensIn: tokens,
      virtualSolReserves: DEVNET_VSOL,
      virtualTokenReserves: VTOK,
      slippageBps: BAND,
    });
    expect(steps.length).to.equal(1);
    expect(steps[0].expectedSolOut).to.equal(plain.netSolOut);
    expect(steps[0].minSolOut).to.equal(plain.minSolOutput);
  });

  it("curve fold: proceeds strictly decrease and floors stay at or below the snapshot floor", () => {
    const balances = wallets([
      "22155565838919",
      "20353725453132",
      "18763408622065",
      "17352475896742",
      "16094925708755",
    ]);
    // The snapshot floor: every wallet quoted against the ORIGINAL reserves,
    // which is exactly the behaviour that reverted on devnet.
    const snapshotFloor = pump.quotePumpSell({
      tokensIn: balances[0].tokens,
      virtualSolReserves: DEVNET_VSOL,
      virtualTokenReserves: VTOK,
      slippageBps: BAND,
    }).minSolOutput;
    const steps = sellFold.foldCurveSells({
      balances,
      virtualSolReserves: DEVNET_VSOL,
      virtualTokenReserves: VTOK,
      slippageBps: BAND,
    });
    expect(steps.length).to.equal(5);
    for (let i = 1; i < steps.length; i++) {
      expect(steps[i].expectedSolOut < steps[i - 1].expectedSolOut).to.equal(
        true,
        `step ${i} must be worse than step ${i - 1}`
      );
    }
    // The head step IS the snapshot case, so its floor must equal it; every
    // later step must be looser or equal.
    expect(steps[0].minSolOut).to.equal(snapshotFloor);
    for (const s of steps) {
      expect(sellFold.floorIsNotTighter(s.minSolOut, snapshotFloor)).to.equal(
        true
      );
    }
    // And the impact is real: the total folded expectation is strictly less
    // than five times the head expectation.
    const foldedTotal = steps.reduce((a, s) => a + s.expectedSolOut, ZERO);
    expect(foldedTotal < steps[0].expectedSolOut * BigInt(5)).to.equal(true);
  });

  it("pool fold: mirrors the SDK shape and only ever gets worse down the order", () => {
    const balances = wallets(["22155565838919", "20353725453132"]);
    const baseReserve = BigInt("206900000000000");
    const quoteReserve = BigInt("2235361842");
    const virtualQuote = BigInt("583150126");
    const feeBpsTotal = BigInt(125);
    const steps = sellFold.foldPoolSells({
      balances,
      baseReserve,
      quoteReserve,
      virtualQuoteReserves: virtualQuote,
      feeBpsTotal,
      slippageBps: BAND,
    });
    expect(steps.length).to.equal(2);
    // Step 1 is the SDK's own formula, spelled out here so a refactor cannot
    // silently change the constant product or the fee direction.
    const effectiveQuote = quoteReserve + virtualQuote;
    const gross =
      (effectiveQuote * balances[0].tokens) / (baseReserve + balances[0].tokens);
    const net = (gross * (BigInt(10_000) - feeBpsTotal)) / BigInt(10_000);
    expect(steps[0].expectedSolOut).to.equal(net);
    expect(steps[0].minSolOut).to.equal(
      (net * (BigInt(10_000) - BAND)) / BigInt(10_000)
    );
    // Step 2 is strictly worse, and its floor is lower than step 1's.
    expect(steps[1].expectedSolOut < steps[0].expectedSolOut).to.equal(true);
    expect(steps[1].minSolOut < steps[0].minSolOut).to.equal(true);
    // Empty and all-zero balances produce no steps rather than a zero floor.
    expect(
      sellFold.foldPoolSells({
        balances: wallets(["0", "0"]),
        baseReserve,
        quoteReserve,
        virtualQuoteReserves: virtualQuote,
        feeBpsTotal,
        slippageBps: BAND,
      }).length
    ).to.equal(0);
  });
});

// STAGE 2B (PLAN-SELLALL-STAGE2-B.md): ORDERED ATOMIC BUNDLE.
//
// The bundle must be assembled in the FOLD order, because each wallet's floor
// was folded against its predecessors: sending it in any other order would
// invalidate the plan. `buildSellBundlePlan` is the pure assembly seam, so the
// order is pinned offline with no relay anywhere near it.
describe("stage 2b: ordered sell bundle", () => {
  const BAND = BigInt(500);

  it("bundle order equals the fold order (highest balance first)", () => {
    // The fold consumes balances in order and emits one step per balance, so
    // the descending input below IS the sell order the bundle must preserve.
    const balances = [
      { address: "wallet-high", tokens: BigInt("3000000000000") },
      { address: "wallet-mid", tokens: BigInt("2000000000000") },
      { address: "wallet-low", tokens: BigInt("1000000000000") },
    ];
    const steps = sellFold.foldCurveSells({
      balances,
      virtualSolReserves: DEVNET_VSOL,
      virtualTokenReserves: VTOK,
      slippageBps: BAND,
    });
    expect(steps.map((s) => s.address)).to.deep.equal([
      "wallet-high",
      "wallet-mid",
      "wallet-low",
    ]);

    const legs = steps.map((s) => ({
      address: s.address,
      wallet: Keypair.generate(),
      instructions: [] as import("@solana/web3.js").TransactionInstruction[],
    }));
    const plan = sellAll.buildSellBundlePlan(legs);

    // The bundle order is exactly the fold order, and the txs align with it.
    expect(plan.order).to.deep.equal(steps.map((s) => s.address));
    expect(plan.txs.length).to.equal(steps.length);
    expect(plan.signersByTx.length).to.equal(steps.length);
    for (let i = 0; i < legs.length; i++) {
      expect(plan.txs[i].feePayer?.toBase58()).to.equal(
        legs[i].wallet.publicKey.toBase58()
      );
      expect(plan.signersByTx[i][0].publicKey.toBase58()).to.equal(
        legs[i].wallet.publicKey.toBase58()
      );
    }
  });

  it('submit: "bundle" refuses on devnet and names the mainnet relays', async () => {
    const connection = new web3.Connection(
      "https://api.devnet.solana.com",
      "confirmed"
    );
    let error: unknown = null;
    try {
      await sellAll.sellAllManagedWallets({
        connection,
        mint: Keypair.generate().publicKey,
        wallets: [],
        submit: "bundle",
      });
    } catch (e) {
      error = e;
    }
    expect(error).to.not.equal(null);
    const message = error instanceof Error ? error.message : String(error);
    expect(message).to.match(/mainnet/i);
    expect(message).to.match(/nextblock/i);
    expect(message).to.match(/astralane/i);
    expect(message).to.match(/bloxroute/i);
  });
});

// STAGE UI (PLAN-UI-SELLALL-STAGE2.md): graduate:false keeps the curve open.
//
// The UI test launch must create a coin WITHOUT graduating it, so the final
// buy takes only its own planned share and the sequence carries no MigrateV2.
// The graduate default must stay byte-for-byte the old fill-and-graduate path.
describe("stage ui: graduate:false keeps the curve open", () => {
  /** A Connection stub good enough for buildLaunchSequence (no network): a
   *  fixed blockhash and a null global account (so the fee-recipient and curve
   *  seeds fall back per cluster). */
  function fakeConnection(): import("@solana/web3.js").Connection {
    return {
      rpcEndpoint: "https://api.devnet.solana.com",
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1,
      }),
      getAccountInfo: async () => null,
    } as unknown as import("@solana/web3.js").Connection;
  }

  it("quoteLaunchBuys(graduate:false) leaves the final buy at its planned share", () => {
    const budget = BigInt(5_000_000);
    const buys = buysFor(3, budget);
    const graduated = launch.quoteLaunchBuys(buys, ZERO, mainnetSeed(), true);
    const open = launch.quoteLaunchBuys(buys, ZERO, mainnetSeed(), false);
    expect(open.length).to.equal(3);
    // Default (graduate) still forces the final buy to take every remaining
    // real token.
    const graduatedHead = graduated
      .slice(0, -1)
      .reduce((a, q) => a + q.tokensOut, ZERO);
    expect(graduated[graduated.length - 1].tokensOut).to.equal(
      RTOK - graduatedHead
    );
    // graduate:false quotes the final buy from ITS OWN budget against the
    // reserves the predecessors leave (the planned share), NOT the remainder.
    let vsr = MAINNET_VSOL;
    let vtr = VTOK;
    for (let i = 0; i < open.length - 1; i++) {
      vsr += open[i].costLamports;
      vtr -= open[i].tokensOut;
    }
    const net =
      (budget * (BigInt(10_000) - pump.PUMP_FEE_BPS)) / BigInt(10_000);
    const planned = (net * vtr) / (vsr + net);
    expect(open[open.length - 1].tokensOut).to.equal(planned);
    // And the curve stays open: the total never reaches the real reserve.
    const totalOpen = open.reduce((a, q) => a + q.tokensOut, ZERO);
    expect(totalOpen < RTOK).to.equal(true);
    expect(open[open.length - 1].tokensOut < RTOK).to.equal(true);
  });

  it("buildLaunchSequence default still carries the MigrateV2", async () => {
    const seq = await launch.buildLaunchSequence({
      connection: fakeConnection(),
      creator: Keypair.generate(),
      name: "Grad",
      symbol: "GRAD",
      uri: "https://example.com/grad.json",
      buys: buysFor(1, BigInt(5_000_000)),
      mintKeypair: Keypair.generate(),
      slippageBps: ZERO,
    });
    expect(seq.migrateIx).to.not.equal(null);
    expect(seq.migrateTx).to.not.equal(null);
  });

  it("buildLaunchSequence(graduate:false) has NO migrate tx", async () => {
    const seq = await launch.buildLaunchSequence({
      connection: fakeConnection(),
      creator: Keypair.generate(),
      name: "Open",
      symbol: "OPEN",
      uri: "https://example.com/open.json",
      buys: buysFor(1, BigInt(5_000_000)),
      mintKeypair: Keypair.generate(),
      slippageBps: ZERO,
      graduate: false,
    });
    expect(seq.migrateIx).to.equal(null);
    expect(seq.migrateTx).to.equal(null);
    expect(seq.buyTxs.length).to.equal(1);
    // create + the single buy, and nothing else.
    expect(seq.signersByTx.length).to.equal(2);
  });

  it("test launch (folded): 5 selected dev wallets pack 5 buys; the creator's buy folds into tx A with NO migrate", async () => {
    const TEST_LAUNCH_DEV_BUY_LAMPORTS = BigInt(10_000_000);
    /** The UI's per-wallet test-launch size: min(capacity, TEST_LAUNCH_DEV_BUY). */
    const planBuy = (capacity: bigint) =>
      TEST_LAUNCH_DEV_BUY_LAMPORTS < capacity
        ? TEST_LAUNCH_DEV_BUY_LAMPORTS
        : capacity;

    // The creator's own capacity plus FIVE selected dev-wallet capacities. Two
    // dev capacities clamp below the standard test size, so the min() is
    // exercised rather than assumed.
    const creatorCapacity = BigInt(30_000_000);
    const devCapacities = [
      BigInt(20_000_000),
      TEST_LAUNCH_DEV_BUY_LAMPORTS,
      BigInt(8_000_000),
      BigInt(5_000_000),
      BigInt(12_000_000),
    ];
    const creator = Keypair.generate();
    const devWallets = devCapacities.map(() => Keypair.generate());

    const creatorBudget = planBuy(creatorCapacity);
    // Print, per dev wallet, the planned buy amount and the capacity it was
    // sized against (the operator must see the plan before sending).
    const devBudgets = devCapacities.map((capacity, i) => {
      const planned = planBuy(capacity);
      console.log(
        `   dev wallet ${i + 1}: capacity ${capacity} lamports -> planned buy ${planned} lamports`
      );
      return planned;
    });
    expect(creatorBudget <= creatorCapacity).to.equal(true);
    for (let i = 0; i < devBudgets.length; i++) {
      expect(devBudgets[i] <= devCapacities[i]).to.equal(true);
    }

    // The FOLDED TEST LAUNCH plan: the creator's buy is `creatorDevBuy` and
    // folds into tx A; the 5 selected dev wallets are the packed buys. This
    // is a folded-shape test: the count moved from 6 packed buys to 5.
    const devBuys = devWallets.map((wallet, i) => ({
      wallet,
      solInLamports: devBudgets[i],
    }));
    expect(devBuys.length).to.equal(5);

    const seq = await launch.buildLaunchSequence({
      connection: fakeConnection(),
      creator,
      name: "Test",
      symbol: "TEST",
      uri: "https://example.com/test.json",
      buys: devBuys,
      creatorDevBuy: { wallet: creator, solInLamports: creatorBudget },
      lookupTable: syntheticAlt(creator.publicKey),
      mintKeypair: Keypair.generate(),
      slippageBps: ZERO,
      graduate: false,
    });
    const packed = seq.buyTxs.reduce((a, bt) => a + bt.wallets.length, 0);
    expect(packed).to.equal(5);
    // The curve stays OPEN: a NON-graduating launch carries NO MigrateV2.
    expect(seq.migrateIx).to.equal(null);
    expect(seq.migrateTx).to.equal(null);
    // create + the packed buy txs, and no trailing creator-only migrate entry.
    expect(seq.signersByTx.length).to.equal(1 + seq.buyTxs.length);
  });

  it("test launch (folded): an unaffordable selected dev wallet is skipped, still NO migrate", async () => {
    const TEST_LAUNCH_DEV_BUY_LAMPORTS = BigInt(10_000_000);
    const planBuy = (capacity: bigint) =>
      TEST_LAUNCH_DEV_BUY_LAMPORTS < capacity
        ? TEST_LAUNCH_DEV_BUY_LAMPORTS
        : capacity;
    const creatorCapacity = BigInt(30_000_000);
    // wallet 2 has zero spendable capacity: reported + skipped by the UI.
    const devCapacities = [BigInt(15_000_000), BigInt(0), BigInt(9_000_000)];
    const creator = Keypair.generate();
    const devWallets = devCapacities.map(() => Keypair.generate());

    // FOLDED SHAPE: the creator's buy is `creatorDevBuy` (tx A); only the 2
    // affordable dev wallets are packed. The count moved from 3 to 2.
    const devBuys = devCapacities.flatMap((capacity, i) =>
      capacity <= BigInt(0)
        ? []
        : [{ wallet: devWallets[i], solInLamports: planBuy(capacity) }]
    );
    expect(devBuys.length).to.equal(2);

    const seq = await launch.buildLaunchSequence({
      connection: fakeConnection(),
      creator,
      name: "Skip",
      symbol: "SKIP",
      uri: "https://example.com/skip.json",
      buys: devBuys,
      creatorDevBuy: {
        wallet: creator,
        solInLamports: planBuy(creatorCapacity),
      },
      lookupTable: syntheticAlt(creator.publicKey),
      mintKeypair: Keypair.generate(),
      slippageBps: ZERO,
      graduate: false,
    });
    expect(seq.migrateIx).to.equal(null);
    expect(seq.migrateTx).to.equal(null);
    const packed = seq.buyTxs.reduce((a, bt) => a + bt.wallets.length, 0);
    expect(packed).to.equal(2);
  });
});

// STAGE UI (PLAN-UI-SELLALL-STAGE2.md): bundle wallet PAIRING. The active Tier
// 2 relays cap a bundle at 4 txs, and a five-wallet sell used to be five txs.
// Two wallets per tx (two signers, first wallet pays) keeps the FOLD order
// across txs AND within a tx and makes five wallets three txs.
describe("stage ui: bundle pairing fits the relay cap", () => {
  function legsWith(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      address: `wallet-${i}`,
      wallet: Keypair.generate(),
      instructions: [
        new web3.TransactionInstruction({
          keys: [],
          programId: PublicKey.default,
          data: Buffer.from([i]),
        }),
      ],
    }));
  }

  it("pairs two wallets per tx, keeping the fold order across and within txs", () => {
    const legs = legsWith(5);
    const plan = sellAll.buildSellBundlePlan(legs, {
      walletsPerTx: 2,
      relayTxCap: sellAll.SELL_BUNDLE_RELAY_TX_CAP,
    });
    expect(plan.txs.length).to.equal(3);
    expect(plan.overCapReason).to.equal(null);
    // Fold order across the txs.
    expect(plan.order).to.deep.equal(legs.map((l) => l.address));
    expect(plan.signersByTx.map((s) => s.length)).to.deep.equal([2, 2, 1]);
    // Fold order WITHIN each tx (instruction order and signer order).
    expect(plan.txs[0].instructions.map((ix) => ix.data[0])).to.deep.equal([
      0, 1,
    ]);
    expect(plan.txs[1].instructions.map((ix) => ix.data[0])).to.deep.equal([
      2, 3,
    ]);
    expect(plan.txs[2].instructions.map((ix) => ix.data[0])).to.deep.equal([
      4,
    ]);
    expect(plan.signersByTx[0][0].publicKey.toBase58()).to.equal(
      legs[0].wallet.publicKey.toBase58()
    );
    expect(plan.signersByTx[0][1].publicKey.toBase58()).to.equal(
      legs[1].wallet.publicKey.toBase58()
    );
    // The pair's FIRST wallet is the fee payer.
    expect(plan.txs[0].feePayer?.toBase58()).to.equal(
      legs[0].wallet.publicKey.toBase58()
    );
    expect(plan.txs[1].feePayer?.toBase58()).to.equal(
      legs[2].wallet.publicKey.toBase58()
    );
    expect(plan.txs[2].feePayer?.toBase58()).to.equal(
      legs[4].wallet.publicKey.toBase58()
    );
  });

  it("the over-cap case returns the readable message instead of rejecting", () => {
    let plan: ReturnType<typeof sellAll.buildSellBundlePlan> | null = null;
    let threw = false;
    try {
      plan = sellAll.buildSellBundlePlan(legsWith(10), {
        walletsPerTx: 2,
        relayTxCap: 4,
      });
    } catch {
      threw = true;
    }
    expect(threw).to.equal(false);
    expect(plan?.txs.length).to.equal(5);
    expect(plan?.overCapReason).to.not.equal(null);
    const msg = plan?.overCapReason ?? "";
    expect(msg).to.match(/cap/i);
    expect(msg).to.contain("10");
    expect(msg).to.contain("5");
    expect(msg).to.contain("4");
    expect(msg).to.match(/perWallet/);
    // The pure helper is the same message source.
    expect(sellAll.sellBundleCapError(10, 2, 4)).to.equal(msg);
    expect(sellAll.sellBundleCapError(8, 2, 4)).to.equal(null);
  });
});

// STAGE 3 (PLAN-SELLALL-SIZE.md): over-size bundle transactions impossible by
// construction. Every assertion below is pure/offline; no test catches a
// "Transaction too large" error. Reference measurements on the Datadog mainnet
// pool 3WkN2cs4rCQthRxnrgqmKgYT28SQJWoqSYzp8eRmPR1D:
//   legacy, 2 pool sells + tip    1279 / 1343 bytes   OVER the 1232 limit
//   v0 + ALT, 2 pool sells + tip   571 bytes          FITS (29 keys in the table)
//   legacy, 2 curve sells + tip    897 bytes          FITS
// The packer mirrors the launch fill packer: a 1150-byte tx budget with a
// 90-byte tip reserve, so the effective per-tx budget is 1060 bytes.
describe("stage 3: measured byte-budget sell packing", () => {
  const MAX_TX_BYTES = 1232;
  const BUDGET =
    sellAll.DEFAULT_SELL_TX_BYTES - sellAll.SELL_TIP_RESERVE_BYTES; // 1060

  /** Curve bundle legs built exactly the way lib/sell-all.ts builds them, with
   *  dummy-but-valid pubkeys (instruction sizes do not depend on the accounts
   *  being real). */
  function curveLegs(n: number) {
    const mint = Keypair.generate().publicKey;
    return Array.from({ length: n }, (_, i) => {
      const wallet = Keypair.generate();
      return {
        address: `wallet-${i}`,
        wallet,
        instructions: pump.buildPumpSellIx({
          mint,
          seller: wallet.publicKey,
          creator: Keypair.generate().publicKey,
          feeRecipient: Keypair.generate().publicKey,
          tokensIn: BigInt("1000000"),
          minSolOutput: BigInt("1"),
        }),
      };
    });
  }

  /** The measured real pool-sell instruction shape (one AMM sell with 24
   *  accounts + the WSOL close with 3 accounts). */
  function poolLegs(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const wallet = Keypair.generate();
      return {
        address: `pool-${i}`,
        wallet,
        instructions: sellAll.poolSellShapeInstructions(wallet.publicKey),
      };
    });
  }

  it("packs 1..5 curve legs at or below the 1060-byte budget; wallets/tx is a measurement", () => {
    for (let n = 1; n <= 5; n++) {
      const plan = sellAll.packSellBundleTxs(curveLegs(n), {
        relayTxCap: sellAll.SELL_BUNDLE_RELAY_TX_CAP,
      });
      console.log(
        `   curve ${n} leg(s) -> ${plan.txs.length} tx(s): ${plan.txs
          .map((t) => t.signedSize)
          .join(", ")} bytes (budget ${BUDGET})`
      );
      expect(plan.versioned).to.equal(false);
      for (const t of plan.txs) {
        expect(t.signedSize).to.be.at.most(BUDGET);
        // The measured capacity is 2: a 944-byte pair fits, a third leg does
        // not. This is the packer's output, never an assumed wallets/tx.
        expect(t.wallets.length).to.be.at.least(1);
        expect(t.wallets.length).to.be.at.most(2);
      }
      const wallets = plan.txs.reduce((a, t) => a + t.wallets.length, 0);
      expect(wallets).to.equal(n);
      expect(plan.txs.length).to.equal(Math.ceil(n / 2));
      expect(plan.overCapReason).to.equal(null);
    }
  });

  it("a synthetic pool pair + tip fits as v0 + ALT and does not fit legacy", () => {
    const legs = poolLegs(2);
    const wA = legs[0].wallet;
    const wB = legs[1].wallet;
    const tip = Keypair.generate();
    const shared = sellAll.collectSharedLookupAccounts(legs);
    const alt = sellAll.syntheticSellLookupTable(
      PublicKey.default,
      shared,
      Keypair.generate().publicKey
    );
    const ixs = [
      ...legs[0].instructions,
      ...legs[1].instructions,
      web3.SystemProgram.transfer({
        fromPubkey: wA.publicKey,
        toPubkey: tip.publicKey,
        lamports: 1_000_000,
      }),
    ];

    // v0 + ALT: serializes under the 1232-byte limit.
    const message = new web3.TransactionMessage({
      payerKey: wA.publicKey,
      recentBlockhash: "11111111111111111111111111111111",
      instructions: ixs,
    }).compileToV0Message([alt]);
    const v0 = new web3.VersionedTransaction(message);
    v0.sign([wA, wB]);
    const v0Size = v0.serialize().length;

    // Legacy: measure the wire size WITHOUT relying on catching the serialize
    // limit error: message bytes + the shortvec signature count + 64 bytes per
    // signature. (The measured legacy pair was 1279 / 1343 bytes.)
    const legacy = new web3.Transaction({
      feePayer: wA.publicKey,
      blockhash: "11111111111111111111111111111111",
      lastValidBlockHeight: 0,
    });
    legacy.add(...ixs);
    legacy.sign(wA, wB);
    const legacySize =
      legacy.serializeMessage().length + 1 + 64 * legacy.signatures.length;

    console.log(
      `   pool pair + tip: v0+ALT ${v0Size} bytes, legacy ${legacySize} bytes (${shared.length} ALT keys)`
    );
    expect(v0Size).to.be.at.most(MAX_TX_BYTES);
    expect(legacySize).to.be.greaterThan(MAX_TX_BYTES);
  });

  it("preserves the fold order across and within the packed transactions", () => {
    const legs = Array.from({ length: 5 }, (_, i) => {
      const wallet = Keypair.generate();
      return {
        address: `wallet-${i}`,
        wallet,
        instructions: [
          new web3.TransactionInstruction({
            keys: [
              { pubkey: wallet.publicKey, isSigner: true, isWritable: true },
            ],
            programId: PublicKey.default,
            data: Buffer.from([i]),
          }),
        ],
      };
    });
    const plan = sellAll.packSellBundleTxs(legs, {
      relayTxCap: sellAll.SELL_BUNDLE_RELAY_TX_CAP,
    });
    const packedIxOrder = plan.txs.flatMap((t) =>
      t.instructions.map((ix) => ix.data[0])
    );
    const packedWalletOrder = plan.txs.flatMap((t) =>
      t.wallets.map((w) => w.publicKey.toBase58())
    );
    expect(packedIxOrder).to.deep.equal([0, 1, 2, 3, 4]);
    expect(packedWalletOrder).to.deep.equal(
      legs.map((l) => l.wallet.publicKey.toBase58())
    );
  });

  it("plan-time cap refusal returns the readable message for a 9-wallet roster on a 4-tx cap", () => {
    const plan = sellAll.packSellBundleTxs(curveLegs(9), { relayTxCap: 4 });
    expect(plan.txs.length).to.equal(5);
    expect(plan.overCapReason).to.not.equal(null);
    const msg = plan.overCapReason as string;
    expect(msg).to.contain("9");
    expect(msg).to.contain("5");
    expect(msg).to.contain("4");
    expect(msg).to.match(/perWallet/);
    expect(sellAll.sellBundleTxCapError(9, 5, 4)).to.equal(msg);
  });
});

// TX A FOLD (PLAN-TXA-FOLD.md): the reference launch's first transaction is a
// V0 message carrying create_v2 + extend_account + the creator's own ATA
// createIdempotent + dev buy, signed by exactly [creator, mint] with the
// creator as fee payer. Offline: synthetic ALT, fake connection, no RPC.
describe("txa fold: the creator dev buy folded into a V0 tx A", () => {
  const MAX_NAME = "N".repeat(32);
  const MAX_SYMBOL = "S".repeat(10);
  const MAX_URI = "u".repeat(200);

  function fakeConnection(): import("@solana/web3.js").Connection {
    return {
      rpcEndpoint: "https://api.devnet.solana.com",
      getLatestBlockhash: async () => ({
        blockhash: "11111111111111111111111111111111",
        lastValidBlockHeight: 1,
      }),
      getAccountInfo: async () => null,
    } as unknown as import("@solana/web3.js").Connection;
  }

  function readU64(buf: Buffer, offset: number): bigint {
    let v = BigInt(0);
    for (let i = 7; i >= 0; i--) {
      v = (v << BigInt(8)) | BigInt(buf[offset + i]);
    }
    return v;
  }

  function ixKind(
    ix: import("@solana/web3.js").TransactionInstruction
  ): string {
    const data = Buffer.from(ix.data);
    if (ix.programId.equals(web3.ComputeBudgetProgram.programId)) {
      if (data[0] === 2) return "cb_limit";
      if (data[0] === 3) return "cb_price";
      return "cb";
    }
    if (ix.programId.equals(pump.PUMP_PROGRAM_ID)) {
      const disc = data.subarray(0, 8);
      if (disc.equals(Buffer.from(pump.PUMP_CREATE_V2_DISCRIMINATOR)))
        return "create_v2";
      if (disc.equals(Buffer.from(pump.PUMP_EXTEND_ACCOUNT_DISCRIMINATOR)))
        return "extend_account";
      if (disc.equals(Buffer.from(pump.PUMP_BUY_DISCRIMINATOR))) return "buy";
      return "pump";
    }
    return "ata";
  }

  /** Builds a folded launch: creatorDevBuy in tx A, `devCount` packed wallets. */
  async function buildFolded(devCount: number) {
    const creator = Keypair.generate();
    const alt = syntheticAlt(creator.publicKey);
    const devWallets = Array.from({ length: devCount }, () =>
      Keypair.generate()
    );
    const buys = devWallets.map((wallet) => ({
      wallet,
      solInLamports: BigInt(3_000_000),
    }));
    const creatorBuy = { wallet: creator, solInLamports: BigInt(50_000_000) };
    const mintKeypair = Keypair.generate();
    const seq = await launch.buildLaunchSequence({
      connection: fakeConnection(),
      creator,
      name: MAX_NAME,
      symbol: MAX_SYMBOL,
      uri: MAX_URI,
      buys,
      creatorDevBuy: creatorBuy,
      lookupTable: alt,
      mintKeypair,
      slippageBps: ZERO,
      graduate: true,
    });
    return { creator, alt, devWallets, buys, creatorBuy, mintKeypair, seq };
  }

  it("PUMP_EXTEND_ACCOUNT_DISCRIMINATOR == sha256('global:extend_account')[0:8]", () => {
    const { createHash } = nodeRequire("crypto") as typeof import("crypto");
    const hash = createHash("sha256").update("global:extend_account").digest();
    expect(pump.PUMP_EXTEND_ACCOUNT_DISCRIMINATOR).to.deep.equal([
      ...hash.subarray(0, 8),
    ]);
  });

  it("buildPumpExtendAccountIx has the five IDL accounts in exact order", () => {
    const creator = Keypair.generate();
    const [bondingCurve] = pump.pumpBondingCurvePda(
      Keypair.generate().publicKey
    );
    const ix = pump.buildPumpExtendAccountIx({
      bondingCurve,
      user: creator.publicKey,
    });
    expect(ix.programId.toBase58()).to.equal(pump.PUMP_PROGRAM_ID.toBase58());
    expect([...ix.data]).to.deep.equal(pump.PUMP_EXTEND_ACCOUNT_DISCRIMINATOR);
    expect(ix.keys.map((k) => k.pubkey.toBase58())).to.deep.equal([
      bondingCurve.toBase58(),
      creator.publicKey.toBase58(),
      web3.SystemProgram.programId.toBase58(),
      pump.PUMP_EVENT_AUTHORITY.toBase58(),
      pump.PUMP_PROGRAM_ID.toBase58(),
    ]);
    // Flags per the official IDL: `account` (the curve) writable, `user`
    // writable + signer, the other three read-only. A read-only `user` still
    // compiles because the creator is the fee payer, so assert it here.
    expect(ix.keys.map((k) => [k.isWritable, k.isSigner])).to.deep.equal([
      [true, false],
      [true, true],
      [false, false],
      [false, false],
      [false, false],
    ]);
    expect(ix.keys[1].isSigner).to.equal(true);
  });

  it("tx A carries CB limit, CB price, create_v2, extend_account, ATA, buy; signs [creator, mint]", async () => {
    const { creator, alt, mintKeypair, seq } = await buildFolded(5);
    expect(seq.createTx instanceof web3.VersionedTransaction).to.equal(true);
    const v0 = seq.createTx as InstanceType<typeof web3.VersionedTransaction>;
    const msg = web3.TransactionMessage.decompile(v0.message, {
      addressLookupTableAccounts: [alt],
    });
    const kinds = msg.instructions.map(ixKind);
    expect(kinds).to.deep.equal([
      "cb_limit",
      "cb_price",
      "create_v2",
      "extend_account",
      "ata",
      "buy",
    ]);
    const staticKeys = v0.message.staticAccountKeys;
    const required = v0.message.header.numRequiredSignatures;
    expect(required).to.equal(2);
    expect(staticKeys[0].toBase58()).to.equal(creator.publicKey.toBase58());
    expect(
      staticKeys.slice(0, required).map((k) => k.toBase58())
    ).to.deep.equal([
      creator.publicKey.toBase58(),
      mintKeypair.publicKey.toBase58(),
    ]);
    // PRINT (required): tx A's instruction list, signer list, serialized size.
    console.log(`   tx A instructions: [${kinds.join(", ")}]`);
    console.log(
      `   tx A signers     : [${staticKeys
        .slice(0, required)
        .map((k) => k.toBase58())
        .join(", ")}] (fee payer ${staticKeys[0].toBase58()})`
    );
    console.log(`   tx A serialized  : ${v0.serialize().length} bytes (no tip)`);
  });

  it("the folded buy is NOT packed; packed count is ceil((n-1)/2)", async () => {
    const { creator, devWallets, seq } = await buildFolded(5);
    // n total buys = 1 creator + 5 dev -> packed = ceil(5/2) = 3 txs.
    expect(seq.buyTxs.length).to.equal(Math.ceil(devWallets.length / 2));
    const packedWallets = seq.buyTxs.flatMap((bt) => bt.wallets);
    expect(packedWallets.length).to.equal(devWallets.length);
    for (const bt of seq.buyTxs) {
      // The creator is never a packed BUYER/signer of a buy tx.
      expect(
        bt.wallets.some((w) => w.publicKey.equals(creator.publicKey))
      ).to.equal(false);
    }
  });

  it("tx A + a 5,000-lamport tip fits 1232 bytes at max metadata", async () => {
    const { creator, alt, seq } = await buildFolded(5);
    const v0 = seq.createTx as InstanceType<typeof web3.VersionedTransaction>;
    const msg = web3.TransactionMessage.decompile(v0.message, {
      addressLookupTableAccounts: [alt],
    });
    const tipIx = web3.SystemProgram.transfer({
      fromPubkey: creator.publicKey,
      toPubkey: Keypair.generate().publicKey,
      lamports: 5_000,
    });
    const withTip = new web3.TransactionMessage({
      payerKey: creator.publicKey,
      recentBlockhash: seq.blockhash.blockhash,
      instructions: [...msg.instructions, tipIx],
    }).compileToV0Message([alt]);
    const bytes = new web3.VersionedTransaction(withTip).serialize().length;
    console.log(`   tx A with 5,000-lamport tip: ${bytes} bytes (limit 1232)`);
    expect(bytes).to.be.at.most(1232);
  });

  it("the folded buy's tokensOut/maxSolCost equal the first quoteLaunchBuys quote", async () => {
    const { creator, alt, buys, creatorBuy, seq } = await buildFolded(5);
    const v0 = seq.createTx as InstanceType<typeof web3.VersionedTransaction>;
    const msg = web3.TransactionMessage.decompile(v0.message, {
      addressLookupTableAccounts: [alt],
    });
    const buyIx = msg.instructions.find((ix) => ixKind(ix) === "buy");
    if (!buyIx) throw new Error("tx A carries no buy instruction");
    const data = Buffer.from(buyIx.data);
    const tokensOut = readU64(data, 8);
    const maxSolCost = readU64(data, 16);
    const seed = await launch.resolveLaunchCurveSeed(fakeConnection());
    const expected = launch.quoteLaunchBuys(
      [
        { wallet: creatorBuy.wallet, solInLamports: creatorBuy.solInLamports },
        ...buys,
      ],
      ZERO,
      seed,
      true
    );
    expect(tokensOut).to.equal(expected[0].tokensOut);
    expect(maxSolCost).to.equal(expected[0].maxSolCost);
    expect(creator.publicKey.toBase58()).to.equal(
      creatorBuy.wallet.publicKey.toBase58()
    );
  });
});
