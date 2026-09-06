// Tier 2 relay submission tests (no network).
//
// Proves the 2026-09-06 Tier 2 relay semantics WITHOUT any live relay
// (relays have no testnet; NextBlock needs an API key, bloXroute needs a JWT
// and Astralane needs an API key that this repo does not hold): NextBlock
// PRIMARY + Astralane Iris / bloXroute OPTIONAL FALLBACKS, each relay
// receiving its OWN provider-specific signed bundle (its own recognized tip
// account in the final tx — never one shared Jito-tipped bundle). The engine
// in lib/bundle/relays.ts and the assembly in lib/bundle/fanout-submit.ts run
// against mock relays that speak the REAL dialects (NextBlock submit-batch
// {entries:[...]}, Astralane JSON-RPC sendBundle with the
// mevProtect/revertProtection config, bloXroute Trader API submit-batch with
// frontRunningProtection), so the request SHAPES are verified byte-for-byte at
// the encoding level and the behavior (sequential NextBlock-first fallback,
// disabled fallback, per-relay tip placement, bundle caps) is proven
// deterministically.
//
// Run: with the local-validator ts-mocha recipe
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$HOME/.config/solana/devnet.json ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json -t 1000000 "tests/pumpfun-m7b-relays.ts"
// or standalone against any RPC (this file makes no chain calls):
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pumpfun-m7b-relays.ts"

import { expect } from "chai";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  submitRelaysSequentially,
  fanOutToRelays,
  buildRelayRequest,
  buildJitoSimulateParams,
  classifyRelayResponse,
  resolveRelayEndpointsFromEnv,
  relayPlanFromEnv,
  RELAY_ORDER,
  TIER2_RELAY_ORDER,
  RELAY_ROLE,
  RELAY_BUNDLE_CAPS,
  RELAY_MIN_TIP_LAMPORTS,
  defaultTipAccountForRelay,
  KNOWN_NEXTBLOCK_TIP_ACCOUNTS,
  KNOWN_ASTRALANE_TIP_ACCOUNTS,
  KNOWN_BLOXROUTE_TIP_ACCOUNTS,
  type RelayLegResult,
  type RelayFanoutResult,
  type RelayId,
} from "../lib/bundle/relays";
import { shouldFinalizeInvalidStatus } from "../lib/bundle/jito";
import { assembleRelayVariants } from "../lib/bundle/fanout-submit";

/** Deterministic fake relay: answers after a fixed delay with a real-dialect
 *  response (accept/reject/error), or throws (unreachable). Records hits. */
interface MockRelay {
  delayMs: number;
  mode: "accept" | "reject" | "throw";
  seenBodies: string[];
  seenUrls: string[];
}

function makeMockRelays(cfg: {
  nextblock?: Partial<MockRelay>;
  astralane?: Partial<MockRelay>;
  bloxroute?: Partial<MockRelay>;
  jito?: Partial<MockRelay>;
}): Record<string, MockRelay> {
  const mocks: Record<string, MockRelay> = {
    nextblock: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
    astralane: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
    bloxroute: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
    jito: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
  };
  for (const [id, c] of Object.entries(cfg)) {
    mocks[id] = { ...mocks[id], ...c };
  }
  return mocks;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A fake fetch wired to the mock relays. It ALSO validates the dialect
 *  shape of each request it sees (encoding-level verification), including
 *  that each relay received ITS OWN bundle variant (no cross-send). */
function mockFetch(
  mocks: Record<string, MockRelay>,
  variants: Partial<Record<RelayId, string[]>>
) {
  return async (url: string, init?: { body?: string }): Promise<Response> => {
    const id: RelayId | null = url.includes("mock-nextblock")
      ? "nextblock"
      : url.includes("mock-astra")
        ? "astralane"
        : url.includes("mock-blox")
          ? "bloxroute"
          : url.includes("mock-jito")
            ? "jito"
            : null;
    if (!id) throw new Error(`mock fetch: unknown url ${url}`);
    const mock = mocks[id];
    mock.seenUrls.push(url);
    const rawBody = String(init?.body ?? "");
    mock.seenBodies.push(rawBody);

    // Dialect shape checks (the encoding-level verification).
    const body = JSON.parse(rawBody);
    const variant = variants[id];
    if (id === "nextblock") {
      // NextBlock submit-batch: {entries:[{transaction:{content}}]} — NO
      // useBundle flag (the endpoint IS the bundle), no per-entry flags.
      expect(Array.isArray(body.entries)).to.equal(true);
      const contents = body.entries.map((e: { transaction: { content: string } }) => e.transaction.content);
      expect(contents).to.deep.equal(variant); // its OWN variant, verbatim
      expect(body.useBundle).to.equal(undefined); // no bloXroute useBundle flag
      for (const e of body.entries) {
        expect(typeof e.transaction.content).to.equal("string");
      }
    }
    if (id === "astralane") {
      expect(url.includes("?api-key=")).to.equal(true);
      expect(body.method).to.equal("sendBundle");
      expect(Array.isArray(body.params)).to.equal(true);
      // Astralane Iris bundle config: [[txns], {encoding, mevProtect,
      // revertProtection}]
      expect(body.params.length).to.equal(2);
      expect(body.params[1]).to.deep.equal({
        encoding: "base64",
        mevProtect: true,
        revertProtection: false,
      });
      expect(body.params[0]).to.deep.equal(variant);
    }
    if (id === "jito") {
      expect(url.endsWith("/bundles")).to.equal(true);
      expect(body.method).to.equal("sendBundle");
      expect(body.params.length).to.equal(2);
      expect(body.params[1]).to.deep.equal({ encoding: "base64" });
      expect(body.params[0]).to.deep.equal(variant);
    }
    if (id === "bloxroute") {
      expect(body.useBundle).to.equal(true); // atomic block-engine bundle
      expect(body.frontRunningProtection).to.equal(true); // MEV protection
      expect(Array.isArray(body.entries)).to.equal(true);
      const contents = body.entries.map((e: { transaction: { content: string } }) => e.transaction.content);
      expect(contents).to.deep.equal(variant); // its OWN variant, verbatim
      for (const e of body.entries) {
        expect(typeof e.transaction.content).to.equal("string");
        expect(typeof e.skipPreflight).to.equal("boolean");
      }
    }

    await sleep(mock.delayMs);
    if (mock.mode === "throw") throw new Error(`${id} network down`);
    const status = 200;
    let rawBody2: string;
    if (mock.mode === "reject") {
      rawBody2 =
        id === "nextblock"
          ? JSON.stringify({ code: 2, message: "fee too low; transaction contains low tip" })
          : id === "bloxroute"
            ? JSON.stringify({ transactions: [{ signature: "sigX", submitted: false }] })
            : JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "simulation failed" } });
    } else {
      rawBody2 =
        id === "nextblock"
          ? JSON.stringify({ signature: "nb-sig-1" })
          : id === "bloxroute"
            ? JSON.stringify({
                transactions: [
                  { signature: "sigblx1", submitted: true },
                  { signature: "sigblx2", submitted: true },
                ],
              })
            : id === "astralane"
              ? JSON.stringify({
                  jsonrpc: "2.0",
                  id: 1,
                  result: ["astra-sig-1", "astra-sig-2"],
                })
              : JSON.stringify({ jsonrpc: "2.0", id: 1, result: `bundle-jito` });
    }
    return new Response(rawBody2, { status });
  };
}

/** Mock endpoints (distinct hosts so mockFetch can route each leg). */
const MOCK_OVERRIDES = {
  nextblock: {
    id: "nextblock" as const,
    url: "https://mock-nextblock.local",
    authHeaderValue: "mock-nb-key",
    authHeaderName: "authorization",
  },
  astralane: {
    id: "astralane" as const,
    url: "https://mock-astra.local/iris",
    authHeaderValue: "mock-key",
  },
  bloxroute: {
    id: "bloxroute" as const,
    url: "https://mock-blox.local/api/v2/submit-batch",
    authHeaderValue: "mock-jwt",
  },
  jito: {
    id: "jito" as const,
    url: "https://mock-jito.local/api/v1",
  },
};

/** Distinct provider-specific variants: each relay must receive exactly its
 *  own array (identical arrays across relays would be the old cross-send
 *  hazard the tests must catch). */
const VARIANTS: Partial<Record<RelayId, string[]>> = {
  nextblock: ["bmV4dDE=", "bmV4dDI=", "bmV4dDM="],
  astralane: ["YXN0cmEx", "YXN0cmEy", "YXN0cmEz"],
  bloxroute: ["YmxveDE=", "YmxveDI=", "YmxveDM="],
  jito: ["aml0bzE=", "aml0bzI="],
};

// ---------------------------------------------------------------------------
// deterministic signing fixtures (no chain)
// ---------------------------------------------------------------------------

function seedKeypair(seed: number): Keypair {
  return Keypair.fromSeed(new Uint8Array(32).fill(seed));
}

/** A deterministic unsigned 1-transfer tx (payer -> dest). The payer's own
 *  pubkey (32 bytes, base58) doubles as a syntactically valid blockhash. */
function makeTx(payer: Keypair, dest: PublicKey, lamports: number): Transaction {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    blockhash: payer.publicKey.toBase58(),
    lastValidBlockHeight: 0,
  });
  tx.add(SystemProgram.transfer({ fromPubkey: payer.publicKey, toPubkey: dest, lamports }));
  return tx;
}

/** All SystemProgram-transfer recipients in a signed tx (base58). The TIP is
 *  the recipient that is one of the OFFICIAL relay tip accounts; a generic
 *  transfer (fund / buy) has an unrelated recipient. */
function transferRecipientsOf(txBase64: string): string[] {
  const tx = Transaction.from(Buffer.from(txBase64, "base64"));
  const out: string[] = [];
  for (const ix of tx.instructions) {
    if (
      ix.programId.equals(SystemProgram.programId) &&
      ix.data.length > 0 &&
      ix.data[0] === 2 // SystemProgram transfer
    ) {
      out.push(ix.keys[1].pubkey.toBase58());
    }
  }
  return out;
}

/** The official tip accounts of every relay (for tip-detection assertions). */
const ALL_TIP_ACCOUNTS = [
  ...KNOWN_NEXTBLOCK_TIP_ACCOUNTS,
  ...KNOWN_ASTRALANE_TIP_ACCOUNTS,
  ...KNOWN_BLOXROUTE_TIP_ACCOUNTS,
];

function assertLegs(legs: RelayLegResult[], expected: Record<string, string>): void {
  for (const leg of legs) {
    expect(leg.status, `${leg.relay} status`).to.equal(expected[leg.relay]);
  }
}

describe("pumpfun (Tier 2: NextBlock primary + Astralane/bloXroute fallback)", () => {
  it("keeps the transient-Invalid grace finalization rule (legacy jito path)", () => {
    expect(shouldFinalizeInvalidStatus(1, 0, false)).to.equal(false);
    expect(shouldFinalizeInvalidStatus(3, 2_999, false)).to.equal(false);
    expect(shouldFinalizeInvalidStatus(3, 3_000, false)).to.equal(true);
    expect(shouldFinalizeInvalidStatus(1, 0, true)).to.equal(true);
  });

  it("builds Jito simulateBundle params with required aligned account configs", () => {
    const txs = ["dHgx", "dHgy", "dHgz"];
    expect(buildJitoSimulateParams(txs)).to.deep.equal([
      { encodedTransactions: txs },
      {
        preExecutionAccountsConfigs: [null, null, null],
        postExecutionAccountsConfigs: [null, null, null],
        skipSigVerify: true,
        transactionEncoding: "base64",
        replaceRecentBlockhash: true,
      },
    ]);
  });

  it("the active Tier 2 order is NextBlock primary then Astralane/bloXroute fallback (no jito)", () => {
    expect(TIER2_RELAY_ORDER).to.deep.equal(["nextblock", "astralane", "bloxroute"]);
    expect(RELAY_ORDER).to.deep.equal(TIER2_RELAY_ORDER);
    expect(RELAY_ROLE.nextblock).to.equal("primary");
    expect(RELAY_ROLE.astralane).to.equal("fallback");
    expect(RELAY_ROLE.bloxroute).to.equal("fallback");
    expect(RELAY_ROLE.jito).to.equal("legacy");
    expect(TIER2_RELAY_ORDER.includes("jito")).to.equal(false);
    // active relays cap bundles at 4 txs; jito (legacy) allows 5
    expect(RELAY_BUNDLE_CAPS.nextblock).to.equal(4);
    expect(RELAY_BUNDLE_CAPS.astralane).to.equal(4);
    expect(RELAY_BUNDLE_CAPS.bloxroute).to.equal(4);
    expect(RELAY_BUNDLE_CAPS.jito).to.equal(5);
    // all active relays floor tips at 0.001 SOL (1M lamports)
    expect(RELAY_MIN_TIP_LAMPORTS.nextblock).to.equal(1_000_000);
    expect(RELAY_MIN_TIP_LAMPORTS.astralane).to.equal(1_000_000);
    expect(RELAY_MIN_TIP_LAMPORTS.bloxroute).to.equal(1_000_000);
  });

  it("the official tip accounts are known per relay (Nextb... / astra... / bLx..., never shared)", () => {
    expect(defaultTipAccountForRelay("nextblock")).to.equal(
      KNOWN_NEXTBLOCK_TIP_ACCOUNTS[0]
    );
    expect(defaultTipAccountForRelay("astralane")).to.equal(
      KNOWN_ASTRALANE_TIP_ACCOUNTS[0]
    );
    expect(defaultTipAccountForRelay("bloxroute")).to.equal(
      KNOWN_BLOXROUTE_TIP_ACCOUNTS[0]
    );
    // the official tip wallet sets are pairwise disjoint
    const nbAstra = KNOWN_NEXTBLOCK_TIP_ACCOUNTS.filter((a) =>
      KNOWN_ASTRALANE_TIP_ACCOUNTS.includes(a)
    );
    const nbBlox = KNOWN_NEXTBLOCK_TIP_ACCOUNTS.filter((a) =>
      KNOWN_BLOXROUTE_TIP_ACCOUNTS.includes(a)
    );
    const astraBlox = KNOWN_ASTRALANE_TIP_ACCOUNTS.filter((a) =>
      KNOWN_BLOXROUTE_TIP_ACCOUNTS.includes(a)
    );
    expect(nbAstra).to.deep.equal([]);
    expect(nbBlox).to.deep.equal([]);
    expect(astraBlox).to.deep.equal([]);
    for (const n of KNOWN_NEXTBLOCK_TIP_ACCOUNTS) {
      new PublicKey(n); // must parse as a valid pubkey
    }
    for (const a of KNOWN_ASTRALANE_TIP_ACCOUNTS) {
      expect(a.startsWith("astra")).to.equal(true);
      new PublicKey(a); // must parse as a valid pubkey
    }
    for (const b of KNOWN_BLOXROUTE_TIP_ACCOUNTS) {
      new PublicKey(b); // must parse as a valid pubkey
    }
  });

  it("builds the exact per-relay request dialects (encoding level)", () => {
    const TXS = ["dGVzdA==", "dGVzdA=="];

    const astra = buildRelayRequest("astralane", TXS, {
      astralane: { id: "astralane", url: "https://edge.astralane.io/iris", authHeaderValue: "key123" },
    });
    expect(astra.url).to.equal("https://edge.astralane.io/iris?api-key=key123");
    expect(astra.headers["api_key"]).to.equal("key123");
    const astraBody = JSON.parse(astra.body);
    expect(astraBody.method).to.equal("sendBundle");
    // [[base64...], {encoding:"base64", mevProtect:true, revertProtection:false}]
    expect(astraBody.params).to.deep.equal([
      TXS,
      { encoding: "base64", mevProtect: true, revertProtection: false },
    ]);

    const blox = buildRelayRequest("bloxroute", TXS, {
      bloxroute: {
        id: "bloxroute",
        url: "https://ny.solana.dex.blxrbdn.com/api/v2/submit-batch",
        authHeaderValue: "jwt-abc",
      },
    });
    expect(blox.headers["Authorization"]).to.equal("jwt-abc");
    const bloxBody = JSON.parse(blox.body);
    expect(bloxBody.useBundle).to.equal(true);
    expect(bloxBody.frontRunningProtection).to.equal(true);
    expect(bloxBody.entries.length).to.equal(2);
    expect(bloxBody.entries[0].transaction.content).to.equal(TXS[0]);
    expect(bloxBody.entries[0].skipPreflight).to.equal(false);

    const jito = buildRelayRequest("jito", TXS);
    expect(jito.url).to.equal("https://mainnet.block-engine.jito.wtf/api/v1/bundles");
    expect(JSON.parse(jito.body).params).to.deep.equal([TXS, { encoding: "base64" }]);

    const nb = buildRelayRequest("nextblock", TXS, {
      nextblock: {
        id: "nextblock",
        url: "https://ny.nextblock.io",
        authHeaderValue: "nb-key",
        authHeaderName: "authorization",
      },
    });
    expect(nb.url).to.equal("https://ny.nextblock.io/api/v2/submit-batch");
    expect(nb.headers["authorization"]).to.equal("nb-key");
    const nbBody = JSON.parse(nb.body);
    expect(nbBody.entries.length).to.equal(2);
    expect(nbBody.entries[0].transaction.content).to.equal(TXS[0]);
    expect(nbBody.entries[0].skipPreflight).to.equal(undefined); // no per-entry flags
    expect(nbBody.useBundle).to.equal(undefined); // no bloXroute useBundle flag
    expect(nbBody.frontRunningProtection).to.equal(undefined);
  });

  it("classifies real-dialect responses (astralane list-of-signatures too)", () => {
    // Astralane sendBundle returns a LIST of tx signatures (docs example)
    const astraList = classifyRelayResponse(
      "astralane",
      200,
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: ["siga", "sigb"] })
    );
    expect(astraList.status).to.equal("accepted");
    expect(astraList.bundleId).to.equal("siga");
    expect(astraList.detail).to.equal("2 txs accepted");

    // ... or a single bundle id (string) — both are accepts
    const astraId = classifyRelayResponse(
      "astralane",
      200,
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: "auuid" })
    );
    expect(astraId).to.deep.equal({ status: "accepted", bundleId: "auuid" });

    const rejected = classifyRelayResponse(
      "astralane",
      200,
      JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "blockhash not found" } })
    );
    expect(rejected.status).to.equal("rejected");
    expect(rejected.detail).to.contain("blockhash not found");

    const blox = classifyRelayResponse(
      "bloxroute",
      200,
      JSON.stringify({ transactions: [{ signature: "s1", submitted: true }] })
    );
    expect(blox).to.deep.equal({ status: "accepted", bundleId: "s1", detail: "1 txs accepted" });

    const nb = classifyRelayResponse(
      "nextblock",
      200,
      JSON.stringify({ signature: "nb-sig-1" })
    );
    expect(nb).to.deep.equal({ status: "accepted", bundleId: "nb-sig-1" });

    const nbReject = classifyRelayResponse(
      "nextblock",
      400,
      JSON.stringify({ code: 2, message: "fee too low; transaction contains low tip", details: [] })
    );
    expect(nbReject.status).to.equal("rejected");
    expect(nbReject.detail).to.contain("fee too low");
    expect(nbReject.detail).to.contain("code 2");
  });

  it("assembles a PROVIDER-SPECIFIC bundle per relay: each pays its OWN official tip account in the LAST tx", async () => {
    const payer = seedKeypair(1);
    const dest = seedKeypair(2).publicKey;
    const txs = [makeTx(payer, dest, 10_000), makeTx(payer, dest, 20_000)];
    const signersByTx = [[payer], [payer]];
    const blockhash = payer.publicKey.toBase58();
    const { variants } = await assembleRelayVariants({
      txs,
      signersByTx,
      blockhash,
      lastValidBlockHeight: 0,
      tipLamports: 1_000_000,
      tipPayer: payer,
      relays: ["astralane", "bloxroute"],
    });

    const astra = variants.astralane!;
    const blox = variants.bloxroute!;
    expect(astra.base64.length).to.equal(2);
    expect(blox.base64.length).to.equal(2);

    // Every non-final tx is IDENTICAL across providers (same fund/create/buy
    // content — only the final tip transfer differs).
    expect(astra.base64[0]).to.equal(blox.base64[0]);
    // The final tx differs: it embeds a different tip account.
    expect(astra.base64[1]).to.not.equal(blox.base64[1]);

    // The tip transfer lands in the LAST tx only, and pays that provider's
    // OWN official account — never the other provider's. (The first tx's
    // transfer recipient is the fixture `dest`, not any official tip.)
    const astraFirst = transferRecipientsOf(astra.base64[0]);
    const bloxFirst = transferRecipientsOf(blox.base64[0]);
    const astraLast = transferRecipientsOf(astra.base64[1]);
    const bloxLast = transferRecipientsOf(blox.base64[1]);
    expect(astraFirst.some((r) => ALL_TIP_ACCOUNTS.includes(r))).to.equal(false);
    expect(bloxFirst.some((r) => ALL_TIP_ACCOUNTS.includes(r))).to.equal(false);
    expect(astraLast).to.include(defaultTipAccountForRelay("astralane"));
    expect(bloxLast).to.include(defaultTipAccountForRelay("bloxroute"));
    expect(astra.tipAccount).to.equal(defaultTipAccountForRelay("astralane"));
    expect(blox.tipAccount).to.equal(defaultTipAccountForRelay("bloxroute"));
    // No cross-provider tip reuse: the astralane variant never references
    // the bloXroute wallet and vice versa.
    expect(astraLast.some((r) => KNOWN_BLOXROUTE_TIP_ACCOUNTS.includes(r))).to.equal(
      false
    );
    expect(bloxLast.some((r) => KNOWN_ASTRALANE_TIP_ACCOUNTS.includes(r))).to.equal(
      false
    );
  });

  it("assembles a NextBlock variant paying its OWN NextBlock tip account in the LAST tx", async () => {
    const payer = seedKeypair(7);
    const dest = seedKeypair(8).publicKey;
    const txs = [makeTx(payer, dest, 10_000), makeTx(payer, dest, 20_000)];
    const { variants } = await assembleRelayVariants({
      txs,
      signersByTx: [[payer], [payer]],
      blockhash: payer.publicKey.toBase58(),
      lastValidBlockHeight: 0,
      tipLamports: 1_000_000,
      tipPayer: payer,
      relays: ["nextblock"],
    });
    const nb = variants.nextblock!;
    expect(nb.base64.length).to.equal(2);
    expect(nb.tipAccount).to.equal(defaultTipAccountForRelay("nextblock"));
    const nbLast = transferRecipientsOf(nb.base64[1]);
    expect(nbLast).to.include(defaultTipAccountForRelay("nextblock"));
    // never pays another provider's wallet
    expect(nbLast.some((r) => KNOWN_ASTRALANE_TIP_ACCOUNTS.includes(r))).to.equal(false);
    expect(nbLast.some((r) => KNOWN_BLOXROUTE_TIP_ACCOUNTS.includes(r))).to.equal(false);
  });

  it("rejects a tip below a relay's 0.001 SOL floor at assembly time", async () => {
    const payer = seedKeypair(3);
    const dest = seedKeypair(4).publicKey;
    const txs = [makeTx(payer, dest, 10_000)];
    let err = "";
    try {
      await assembleRelayVariants({
        txs,
        signersByTx: [[payer]],
        blockhash: payer.publicKey.toBase58(),
        lastValidBlockHeight: 0,
        tipLamports: 5_000, // below the 1M astralane/bloxroute floor
        tipPayer: payer,
        relays: ["astralane"],
      });
    } catch (e) {
      err = e instanceof Error ? e.message : String(e);
    }
    expect(err).to.contain("below astralane's");
    expect(err).to.contain("0.001 SOL");
  });

  it("submits NextBlock FIRST in the active order: a NextBlock accept stops the run — no fallback fires", async () => {
    const mocks = makeMockRelays({ nextblock: { delayMs: 5, mode: "accept" } });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("nextblock");
    expect(r.accepted?.bundleId).to.equal("nb-sig-1");
    // the fallbacks were NEVER attempted
    expect(mocks.astralane.seenBodies.length).to.equal(0);
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
    expect(mocks.nextblock.seenBodies.length).to.equal(1);
    expect(r.legs.map((l) => l.relay)).to.deep.equal(["nextblock"]);
  });

  it("falls back to Astralane ONLY when NextBlock rejects", async () => {
    const mocks = makeMockRelays({
      nextblock: { mode: "reject" },
      astralane: { mode: "accept" },
    });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("astralane");
    const nb = r.legs.find((l) => l.relay === "nextblock");
    expect(nb?.status).to.equal("rejected");
    expect(nb?.detail).to.contain("fee too low");
    expect(mocks.nextblock.seenBodies.length).to.equal(1);
    expect(mocks.astralane.seenBodies.length).to.equal(1);
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
  });

  it("submits SEQUENTIALLY: an Astralane accept stops the run — bloXroute is never fired", async () => {
    const mocks = makeMockRelays({ astralane: { delayMs: 5, mode: "accept" } });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const started = Date.now();
    const r: RelayFanoutResult = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane", "bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 3_000,
    });
    const elapsed = Date.now() - started;
    expect(r.accepted?.relay).to.equal("astralane");
    expect(r.accepted?.bundleId).to.equal("astra-sig-1");
    // bloXroute was NEVER attempted (sequential: no simultaneous send).
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
    expect(mocks.astralane.seenBodies.length).to.equal(1);
    expect(elapsed).to.be.lessThan(1_000);
    // each leg outcome is reported in order
    expect(r.legs.map((l) => l.relay)).to.deep.equal(["astralane"]);
  });

  it("falls back to bloXroute ONLY when Astralane explicitly rejects", async () => {
    const mocks = makeMockRelays({
      astralane: { mode: "reject" },
      bloxroute: { mode: "accept" },
    });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane", "bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("bloxroute");
    expect(r.accepted?.bundleId).to.equal("sigblx1");
    const astra = r.legs.find((l) => l.relay === "astralane");
    expect(astra?.status).to.equal("rejected");
    expect(astra?.detail).to.contain("simulation failed");
    // bloXroute received its OWN variant (verified inside mockFetch), and it
    // was only attempted AFTER astralane rejected.
    expect(mocks.astralane.seenBodies.length).to.equal(1);
    expect(mocks.bloxroute.seenBodies.length).to.equal(1);
  });

  it("falls back to bloXroute when Astralane is unreachable", async () => {
    const mocks = makeMockRelays({
      astralane: { mode: "throw" },
      bloxroute: { delayMs: 5, mode: "accept" },
    });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane", "bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("bloxroute");
    expect(r.legs.find((l) => l.relay === "astralane")?.status).to.equal("unreachable");
    expect(mocks.bloxroute.seenBodies.length).to.equal(1);
  });

  it("a DISABLED fallback is never fired and reports disabled honestly", async () => {
    // Only astralane configured server-side; the engine must not touch
    // bloXroute and must say why.
    const mocks = makeMockRelays({ astralane: { delayMs: 5, mode: "accept" } });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("astralane");
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
    const blox = r.legs.find((l) => l.relay === "bloxroute");
    // (no bloxroute leg in the returned legs — it was never attempted; the
    // caller learns it from the relay plan instead)
    expect(blox).to.equal(undefined);
  });

  it("with bloXroute configured but Astralane NOT, bloxroute is the only fired leg", async () => {
    const mocks = makeMockRelays({ bloxroute: { delayMs: 5, mode: "accept" } });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: ["astralane", "bloxroute"],
      enabled: ["bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("bloxroute");
    const legs = Object.fromEntries(r.legs.map((l) => [l.relay, l.status]));
    expect(legs.astralane).to.equal("disabled");
    expect(mocks.astralane.seenBodies.length).to.equal(0);
    expect(mocks.bloxroute.seenBodies.length).to.equal(1);
  });

  it("nothing accepted returns every leg's honest verdict", async () => {
    const mocks = makeMockRelays({
      astralane: { mode: "reject" },
      bloxroute: { mode: "reject" },
    });
    const fetchFn = mockFetch(mocks, VARIANTS);
    const r = await submitRelaysSequentially({
      bundles: VARIANTS,
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane", "bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted).to.equal(null);
    assertLegs(r.legs, { astralane: "rejected", bloxroute: "rejected" });
  });

  it("honors per-relay bundle caps (4 txs): an over-cap variant is skipped, never truncated or cross-sent", async () => {
    const big: Partial<Record<RelayId, string[]>> = {
      astralane: Array.from({ length: 5 }, () => "dGVzdA=="),
      bloxroute: Array.from({ length: 5 }, () => "dGVzdA=="),
    };
    const mocks = makeMockRelays({});
    const fetchFn = mockFetch(mocks, big);
    const r = await submitRelaysSequentially({
      bundles: big,
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane", "bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(mocks.astralane.seenBodies.length).to.equal(0);
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
    expect(r.accepted).to.equal(null);
    const legs = Object.fromEntries(r.legs.map((l) => [l.relay, l.status]));
    expect(legs.astralane).to.equal("skipped");
    expect(legs.bloxroute).to.equal("skipped");
    expect(r.legs[0].detail).to.contain(String(RELAY_BUNDLE_CAPS.astralane));
  });

  it("a relay with no assembled variant is skipped with an honest detail", async () => {
    const mocks = makeMockRelays({ bloxroute: { mode: "accept" } });
    const fetchFn = mockFetch(mocks, { bloxroute: VARIANTS.bloxroute! });
    const r = await submitRelaysSequentially({
      bundles: { bloxroute: VARIANTS.bloxroute! },
      relays: ["astralane", "bloxroute"],
      enabled: ["astralane", "bloxroute"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("bloxroute");
    const legs = Object.fromEntries(r.legs.map((l) => [l.relay, l.status]));
    expect(legs.astralane).to.equal("skipped");
    expect(r.legs[0].detail).to.contain("no provider-specific signed bundle");
  });

  it("resolves the relay plan from the server env: nextblock primary with the API key, astralane/bloxroute fallback, jito never", () => {
    const prevN = process.env.NEXTBLOCK_API_KEY;
    const prevA = process.env.ASTRALANE_API_KEY;
    const prevB = process.env.BLOXROUTE_JWT;
    const prevJ = process.env.RELAY_JITO_URL;
    try {
      delete process.env.NEXTBLOCK_API_KEY;
      delete process.env.ASTRALANE_API_KEY;
      delete process.env.BLOXROUTE_JWT;
      delete process.env.RELAY_JITO_URL;
      const none = resolveRelayEndpointsFromEnv();
      expect(none.enabled).to.deep.equal([]);
      const planNone = relayPlanFromEnv();
      expect(planNone.map((r) => r.configured)).to.deep.equal([false, false, false]);

      process.env.NEXTBLOCK_API_KEY = "nb-key";
      process.env.ASTRALANE_API_KEY = "astra-key";
      process.env.BLOXROUTE_JWT = "blox-jwt";
      const all = resolveRelayEndpointsFromEnv();
      // order matters: nextblock first (primary), then astralane, then bloxroute
      expect(all.enabled).to.deep.equal(["nextblock", "astralane", "bloxroute"]);
      const plan = relayPlanFromEnv();
      expect(plan).to.deep.equal([
        { id: "nextblock", configured: true, role: "primary" },
        { id: "astralane", configured: true, role: "fallback" },
        { id: "bloxroute", configured: true, role: "fallback" },
      ]);

      delete process.env.NEXTBLOCK_API_KEY;
      const noPrimary = resolveRelayEndpointsFromEnv();
      expect(noPrimary.enabled).to.deep.equal(["astralane", "bloxroute"]);

      delete process.env.ASTRALANE_API_KEY;
      const bloxOnly = resolveRelayEndpointsFromEnv();
      expect(bloxOnly.enabled).to.deep.equal(["bloxroute"]);

      // even with a jito URL configured, jito is NEVER enabled on the
      // active Tier 2 path
      process.env.RELAY_JITO_URL = "https://mock-jito.local/api/v1";
      delete process.env.BLOXROUTE_JWT;
      expect(resolveRelayEndpointsFromEnv().enabled).to.deep.equal([]);
    } finally {
      if (prevN === undefined) delete process.env.NEXTBLOCK_API_KEY;
      else process.env.NEXTBLOCK_API_KEY = prevN;
      if (prevA === undefined) delete process.env.ASTRALANE_API_KEY;
      else process.env.ASTRALANE_API_KEY = prevA;
      if (prevB === undefined) delete process.env.BLOXROUTE_JWT;
      else process.env.BLOXROUTE_JWT = prevB;
      if (prevJ === undefined) delete process.env.RELAY_JITO_URL;
      else process.env.RELAY_JITO_URL = prevJ;
    }
  });

  it("LEGACY: fanOutToRelays still fires a single explicitly-listed jito leg (diagnostic path)", async () => {
    const mocks = makeMockRelays({ jito: { delayMs: 5, mode: "accept" } });
    const fetchFn = mockFetch(mocks, { jito: VARIANTS.jito! });
    const r = await fanOutToRelays({
      base64: VARIANTS.jito!,
      relays: ["jito"],
      enabled: ["jito"],
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("jito");
    expect(mocks.jito.seenBodies.length).to.equal(1);
  });

  it("assembles a jito-legacy variant only when jito is explicitly requested", async () => {
    const payer = seedKeypair(5);
    const dest = seedKeypair(6).publicKey;
    const txs = [makeTx(payer, dest, 10_000)];
    const { variants } = await assembleRelayVariants({
      txs,
      signersByTx: [[payer]],
      blockhash: payer.publicKey.toBase58(),
      lastValidBlockHeight: 0,
      tipLamports: 1_000_000,
      tipPayer: payer,
      relays: ["jito"], // legacy: only fires when explicitly listed
    });
    // The default order never assembles a jito variant.
    expect(variants.jito).to.not.equal(undefined);
    // the jito-legacy variant's tip pays the well-known jito account
    expect(transferRecipientsOf(variants.jito!.base64[0])).to.include(
      defaultTipAccountForRelay("jito")
    );
  });
});
