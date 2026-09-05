// Milestone M7b: relay fan-out engine tests (no network).
//
// Proves the M7b fan-out semantics WITHOUT any live relay (relays have no
// testnet; bloXroute needs a JWT and Astralane needs an API key that this
// repo does not hold): the engine in lib/bundle/relays.ts runs against mock
// relays that speak the REAL dialects (Jito + Astralane JSON-RPC sendBundle,
// bloXroute Trader API submit-batch), so the request SHAPES are verified
// byte-for-byte at the encoding level and the fan-out behavior (parallel
// fire, first-accept-wins, per-leg failure isolation, bundle caps, disabled
// legs) is proven deterministically.
//
// Run: with the local-validator ts-mocha recipe
//   ANCHOR_PROVIDER_URL=http://127.0.0.1:8899 ANCHOR_WALLET=$HOME/.config/solana/devnet.json ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json -t 1000000 "tests/pumpfun-m7b-relays.ts"
// or standalone against any RPC (this file makes no chain calls):
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pumpfun-m7b-relays.ts"

import { expect } from "chai";
import {
  fanOutToRelays,
  buildRelayRequest,
  classifyRelayResponse,
  jitoSimulateBundle,
  RELAY_ORDER,
  RELAY_BUNDLE_CAPS,
  type RelayLegResult,
  type RelayFanoutResult,
} from "../lib/bundle/relays";

/** Deterministic fake relay: answers after a fixed delay with a real-dialect
 *  response (accept/reject/error), or throws (unreachable). Records hits. */
interface MockRelay {
  delayMs: number;
  mode: "accept" | "reject" | "throw" | "timeout";
  seenBodies: string[];
  seenUrls: string[];
}

function makeMockRelays(cfg: {
  jito?: Partial<MockRelay>;
  bloxroute?: Partial<MockRelay>;
  astralane?: Partial<MockRelay>;
}): Record<string, MockRelay> {
  const mocks: Record<string, MockRelay> = {
    jito: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
    bloxroute: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
    astralane: { delayMs: 5, mode: "accept", seenBodies: [], seenUrls: [] },
  };
  for (const [id, c] of Object.entries(cfg)) {
    mocks[id] = { ...mocks[id], ...c };
  }
  return mocks;
}

/** A fake fetch wired to the mock relays. It ALSO validates the dialect
 *  shape of each request it sees (encoding-level verification). */
function mockFetch(mocks: Record<string, MockRelay>) {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  return async (url: string, init?: { body?: string }): Promise<Response> => {
    // Which relay does this URL belong to? (mock URLs are distinct hosts)
    const id = url.includes("mock-jito")
      ? "jito"
      : url.includes("mock-blox")
        ? "bloxroute"
        : url.includes("mock-astra")
          ? "astralane"
          : null;
    if (!id) throw new Error(`mock fetch: unknown url ${url}`);
    const mock = mocks[id];
    mock.seenUrls.push(url);
    mock.seenBodies.push(String(init?.body ?? ""));

    // Dialect shape checks (the encoding-level verification).
    const body = JSON.parse(String(init?.body ?? "{}"));
    if (id === "jito") {
      expect(url.endsWith("/bundles")).to.equal(true);
      expect(body.method).to.equal("sendBundle");
      expect(Array.isArray(body.params)).to.equal(true);
      expect(body.params.length).to.equal(2);
      expect(body.params[1]).to.deep.equal({ encoding: "base64" });
      expect(Array.isArray(body.params[0])).to.equal(true);
    }
    if (id === "astralane") {
      expect(body.method).to.equal("sendBundle");
      expect(Array.isArray(body.params)).to.equal(true);
      expect(body.params.length).to.equal(1); // no encoding object
      expect(Array.isArray(body.params[0])).to.equal(true);
    }
    if (id === "bloxroute") {
      expect(body.useBundle).to.equal(true); // atomic block-engine bundle
      expect(Array.isArray(body.entries)).to.equal(true);
      for (const e of body.entries) {
        expect(typeof e.transaction.content).to.equal("string");
        expect(typeof e.skipPreflight).to.equal("boolean");
      }
    }

    await sleep(mock.delayMs);
    if (mock.mode === "throw") throw new Error(`${id} network down`);
    if (mock.mode === "timeout") {
      // Never resolves: the engine's per-leg timeout must bound this leg.
      await new Promise(() => undefined);
    }
    const status = 200;
    let rawBody: string;
    if (mock.mode === "reject") {
      rawBody =
        id === "bloxroute"
          ? JSON.stringify({ transactions: [{ signature: "sigX", submitted: false }] })
          : JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: -32603, message: "simulation failed" } });
    } else {
      rawBody =
        id === "bloxroute"
          ? JSON.stringify({
              transactions: [
                { signature: "sigblx1", submitted: true },
                { signature: "sigblx2", submitted: true },
              ],
            })
          : JSON.stringify({ jsonrpc: "2.0", id: 1, result: `bundle-${id}` });
    }
    return new Response(rawBody, { status });
  };
}

const TXS_2 = ["dGVzdA==", "dGVzdA=="]; // 2 fake signed txs (base64)
const TXS_5 = Array.from({ length: 5 }, () => "dGVzdA==");
const TXS_6 = Array.from({ length: 6 }, () => "dGVzdA==");

/** Mock endpoints (distinct hosts so mockFetch can route each leg). */
const MOCK_OVERRIDES = {
  jito: { id: "jito" as const, url: "https://mock-jito.local/api/v1" },
  bloxroute: {
    id: "bloxroute" as const,
    url: "https://mock-blox.local/api/v2/submit-batch",
    authHeaderValue: "mock-jwt",
  },
  astralane: {
    id: "astralane" as const,
    url: "https://mock-astra.local/iris",
    authHeaderValue: "mock-key",
  },
};

function assertLegs(legs: RelayLegResult[], expected: Record<string, string>): void {
  for (const leg of legs) {
    expect(leg.status, `${leg.relay} status`).to.equal(expected[leg.relay]);
  }
}

describe("pumpfun (M7b: relay fan-out engine)", () => {
  it("builds the exact per-relay request dialects (encoding level)", () => {
    const jito = buildRelayRequest("jito", TXS_2);
    expect(jito.url).to.equal("https://mainnet.block-engine.jito.wtf/api/v1/bundles");
    expect(JSON.parse(jito.body).method).to.equal("sendBundle");
    expect(JSON.parse(jito.body).params).to.deep.equal([TXS_2, { encoding: "base64" }]);

    const astra = buildRelayRequest("astralane", TXS_2, {
      astralane: { id: "astralane", url: "https://edge.astralane.io/iris", authHeaderValue: "key123" },
    });
    expect(astra.url).to.equal("https://edge.astralane.io/iris?api-key=key123");
    expect(JSON.parse(astra.body).params).to.deep.equal([TXS_2]);

    const blox = buildRelayRequest("bloxroute", TXS_2, {
      bloxroute: {
        id: "bloxroute",
        url: "https://ny.solana.dex.blxrbdn.com/api/v2/submit-batch",
        authHeaderValue: "jwt-abc",
      },
    });
    expect(blox.headers["Authorization"]).to.equal("jwt-abc");
    const bloxBody = JSON.parse(blox.body);
    expect(bloxBody.useBundle).to.equal(true);
    expect(bloxBody.entries.length).to.equal(2);
  });

  it("classifies real-dialect responses: jsonrpc result = accept, error = reject, submit-batch submitted = accept", () => {
    expect(
      classifyRelayResponse("jito", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "uuid9" }))
    ).to.deep.equal({ status: "accepted", bundleId: "uuid9" });
    expect(
      classifyRelayResponse("astralane", 200, JSON.stringify({ jsonrpc: "2.0", id: 1, result: "auuid" }))
    ).to.deep.equal({ status: "accepted", bundleId: "auuid" });
    const rejected = classifyRelayResponse(
      "jito",
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
  });

  it("fires all three relays in PARALLEL and first-accept-wins goes to the fastest acceptor", async () => {
    // bloXroute is the fastest acceptor (10ms); Jito and Astralane are slow
    // (1500ms). If the engine awaited every leg, it could not return before
    // ~1500ms; first-accept-wins must return almost immediately instead.
    // (WSL timer granularity quantizes async completions, so the margins are
    // wide rather than tight.)
    const mocks = makeMockRelays({
      jito: { delayMs: 1500 },
      astralane: { delayMs: 1500 },
      bloxroute: { delayMs: 10 },
    });
    const fetchFn = mockFetch(mocks);
    const started = Date.now();
    const r: RelayFanoutResult = await fanOutToRelays({
      base64: TXS_2,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 3_000,
    });
    const elapsed = Date.now() - started;

    // All three fired (parallel fan-out, no serialization).
    expect(mocks.jito.seenBodies.length).to.equal(1);
    expect(mocks.bloxroute.seenBodies.length).to.equal(1);
    expect(mocks.astralane.seenBodies.length).to.equal(1);

    // First accept wins: bloXroute (10ms) beat Jito/Astralane (1500ms).
    expect(r.accepted?.relay).to.equal("bloxroute");
    expect(r.accepted?.bundleId).to.equal("sigblx1");
    // The engine returned LONG before the slow acceptors settled (which
    // would need >= 1500ms), proving it did not await the stragglers.
    expect(elapsed).to.be.lessThan(1_000);
  });

  it("primary Jito rejection falls through to the next accepting relay", async () => {
    const mocks = makeMockRelays({
      jito: { mode: "reject" },
      bloxroute: { mode: "reject" },
      astralane: { delayMs: 5, mode: "accept" },
    });
    const fetchFn = mockFetch(mocks);
    const r = await fanOutToRelays({
      base64: TXS_2,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted?.relay).to.equal("astralane");
    expect(r.accepted?.bundleId).to.equal("bundle-astralane");
    const jito = r.legs.find((l) => l.relay === "jito");
    expect(jito?.status).to.equal("rejected");
    expect(jito?.detail).to.contain("simulation failed");
  });

  it("an unreachable relay cannot block the others (failure isolation)", async () => {
    const mocks = makeMockRelays({
      bloxroute: { mode: "throw" },
      astralane: { mode: "timeout" }, // engine timeout must bound this
      jito: { delayMs: 5, mode: "accept" },
    });
    const fetchFn = mockFetch(mocks);
    const started = Date.now();
    const r = await fanOutToRelays({
      base64: TXS_2,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
      timeoutMs: 300,
    });
    const elapsed = Date.now() - started;
    expect(r.accepted?.relay).to.equal("jito");
    const legs = Object.fromEntries(r.legs.map((l) => [l.relay, l.status]));
    expect(legs.jito).to.equal("accepted");
    expect(legs.bloxroute).to.equal("unreachable");
    // The astralane leg never settles (mode timeout): the engine returned on
    // jito's fast accept, so that straggler may not be in the snapshot. What
    // matters is that it did NOT block the call (bounded fast return).
    if (legs.astralane) expect(legs.astralane).to.equal("unreachable");
    expect(mocks.astralane.seenBodies.length).to.equal(1); // it WAS fired
    // Bounded: the astralane timeout leg (300ms) cannot stretch the call past
    // the accepted fast path plus a small margin.
    expect(elapsed).to.be.lessThan(2_000);
  });

  it("nothing accepted returns every leg's honest verdict", async () => {
    const mocks = makeMockRelays({
      jito: { mode: "reject" },
      astralane: { mode: "reject" },
      bloxroute: { mode: "reject" },
    });
    const fetchFn = mockFetch(mocks);
    const r = await fanOutToRelays({
      base64: TXS_2,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r.accepted).to.equal(null);
    assertLegs(r.legs, { jito: "rejected", bloxroute: "rejected", astralane: "rejected" });
  });

  it("bundle caps are honored: over a relay's cap the leg is skipped, never truncated", async () => {
    const mocks = makeMockRelays({});
    const fetchFn = mockFetch(mocks);
    // 5 txs: Jito (cap 5) fires; Astralane + bloXroute (cap 4) skip.
    const r5 = await fanOutToRelays({
      base64: TXS_5,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(mocks.jito.seenBodies.length).to.equal(1);
    expect(mocks.astralane.seenBodies.length).to.equal(0);
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
    const legs5 = Object.fromEntries(r5.legs.map((l) => [l.relay, l.status]));
    expect(legs5.astralane).to.equal("skipped");
    expect(legs5.bloxroute).to.equal("skipped");
    expect(r5.legs.find((l) => l.relay === "astralane")?.detail).to.contain(
      String(RELAY_BUNDLE_CAPS.astralane)
    );

    // 6 txs: over EVERY relay's cap, nothing fires.
    const mocks2 = makeMockRelays({});
    const r6 = await fanOutToRelays({
      base64: TXS_6,
      relays: RELAY_ORDER,
      enabled: RELAY_ORDER,
      overrides: MOCK_OVERRIDES,
      fetchFn: mockFetch(mocks2) as unknown as typeof fetch,
    });
    expect(mocks2.jito.seenBodies.length).to.equal(0);
    expect(r6.accepted).to.equal(null);
  });

  it("relays without credentials report disabled and are never fired", async () => {
    const mocks = makeMockRelays({});
    const fetchFn = mockFetch(mocks);
    const r = await fanOutToRelays({
      base64: TXS_2,
      relays: RELAY_ORDER,
      enabled: ["jito"], // only the open relay is configured
      overrides: MOCK_OVERRIDES,
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(mocks.bloxroute.seenBodies.length).to.equal(0);
    expect(mocks.astralane.seenBodies.length).to.equal(0);
    const legs = Object.fromEntries(r.legs.map((l) => [l.relay, l.status]));
    expect(legs.jito).to.equal("accepted");
    expect(legs.bloxroute).to.equal("disabled");
    expect(legs.astralane).to.equal("disabled");
  });
});

describe("pumpfun (M7b: Jito simulateBundle diagnostic)", () => {
  it("fires simulateBundle with the sendBundle dialect and parses the exact RpcBundleExecutionError", async () => {
    const seen: { url: string; body: string }[] = [];
    const fetchFn = async (url: string, init?: { body?: string }): Promise<Response> => {
      seen.push({ url, body: String(init?.body ?? "") });
      const body = JSON.parse(String(init?.body ?? "{}"));
      expect(body.method).to.equal("simulateBundle");
      expect(Array.isArray(body.params)).to.equal(true);
      expect(body.params.length).to.equal(2);
      expect(body.params[1]).to.deep.equal({ encoding: "base64" });
      expect(Array.isArray(body.params[0])).to.equal(true);
      const raw = JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        result: {
          context: { slot: 444500000 },
          value: {
            summary: "Failed",
            error:
              "TransactionFailure(4vJ9JU1kA3cKpnF2cMfLqb7V2VqF6aHKHwvvSQYmnv3sFgVHQVShgAWzVmxvQv4S2dW9qF3zYRqzBgZFcGmJfEhD, {InstructionError: [0, Custom: 6000]})",
          },
        },
      });
      return new Response(raw, { status: 200 });
    };
    const r = await jitoSimulateBundle(TXS_2, {
      endpoint: "https://mock-jito.local/api/v1",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(seen.length).to.equal(1);
    expect(seen[0].url).to.equal("https://mock-jito.local/api/v1/bundles");
    expect(r).to.not.equal(null);
    expect(r?.summary).to.equal("Failed");
    expect(r?.error).to.contain("TransactionFailure");
    expect(r?.error).to.contain("Custom: 6000");
  });

  it("returns null on a network failure (best-effort, never throws)", async () => {
    const fetchFn = async (): Promise<Response> => {
      throw new Error("mock network down");
    };
    const r = await jitoSimulateBundle(TXS_2, {
      endpoint: "https://mock-jito.local/api/v1",
      fetchFn: fetchFn as unknown as typeof fetch,
    });
    expect(r).to.equal(null);
  }).timeout(6_000); // fetchJsonRpc backs off 800ms + 1600ms before giving up
});
