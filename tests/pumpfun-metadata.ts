// Milestone M9: metadata builder + publish engine tests (no network, no
// credentials).
//
// Proves the structured-metadata JSON builder (lib/metadata.ts) and the
// publish engine's vps + ipfs dialects (lib/metadata-publish.ts) with MOCK
// fetch that validates the request SHAPES exactly like the M7b relay tests:
// URL, headers, body bytes. This repo holds no VPS secret and no Pinata
// JWT, so nothing here touches a live backend. The LIVE vps leg (real HTTP
// against the dependency-free receiver) is rehearsed by
// scripts/metadata-smoke.mjs.
//
// Run (no chain calls, no validator needed):
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/pumpfun-metadata.ts"

import { expect } from "chai";
import {
  assertUriFitsOnChain,
  buildTokenMetadataJson,
  describeMetadataProblems,
  normalizeSocialUrl,
  normalizeWebsiteUrl,
  type TokenMetadataFields,
} from "../lib/metadata";
import {
  isAllowedImageType,
  publishTokenMetadataBundle,
  resolveMetadataBackendFromEnv,
  sanitizeImageFilename,
  type ImageUpload,
  type MetadataBackendConfig,
} from "../lib/metadata-publish";

const FIELDS: TokenMetadataFields = {
  name: "M9 Test Coin",
  symbol: "M9TC",
  description: "A token that tests metadata publishing",
  website: "https://example.com",
  twitter: "@m9test",
  telegram: "m9group",
};

const IMAGE: ImageUpload = {
  filename: "coin.png",
  contentType: "image/png",
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
};

interface RecordedCall {
  url: string;
  init?: RequestInit;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** chai-as-promised is NOT installed in this repo: assert a rejection with
 *  plain try/catch and match the message (the m7b suites do the same). */
async function expectRejects(
  p: Promise<unknown>,
  pattern: RegExp
): Promise<void> {
  let thrown: unknown = null;
  try {
    await p;
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected the promise to reject").to.not.equal(null);
  const msg = thrown instanceof Error ? thrown.message : String(thrown);
  expect(msg).to.match(pattern);
}

/** Body of a recorded fetch call as an ArrayBuffer (image PUTs send raw
 *  ArrayBuffer bytes; JSON PUTs send strings). */
function bodyBytes(init?: RequestInit): Uint8Array {
  const b = init?.body;
  if (typeof b === "string") return new TextEncoder().encode(b);
  return new Uint8Array(b as ArrayBuffer);
}

/** Fake fetch that records calls and answers per a per-URL route table. */
function mockFetch(
  calls: RecordedCall[],
  route: (url: string, init?: RequestInit) => Response
): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    return route(u, init);
  }) as typeof fetch;
}

const VPS_CONFIG: MetadataBackendConfig = {
  id: "vps",
  vps: {
    uploadUrl: "https://meta.example.com/put",
    baseUrl: "https://meta.example.com",
    secret: "s3cret",
  },
};

describe("metadata JSON builder", () => {
  it("omits empty optional fields and mirrors website into external_url", () => {
    const json = buildTokenMetadataJson({
      name: "N",
      symbol: "S",
      description: "",
      website: "",
      twitter: "",
      telegram: "",
      imageUrl: "",
    });
    expect(json).to.deep.equal({ name: "N", symbol: "S" });
  });

  it("composes the pump.fun-style JSON with normalized socials", () => {
    const json = buildTokenMetadataJson({
      ...FIELDS,
      imageUrl: "https://meta.example.com/ab12/coin.png",
    });
    expect(json).to.deep.equal({
      name: "M9 Test Coin",
      symbol: "M9TC",
      description: "A token that tests metadata publishing",
      image: "https://meta.example.com/ab12/coin.png",
      website: "https://example.com",
      external_url: "https://example.com",
      twitter: "https://x.com/m9test",
      telegram: "https://t.me/m9group",
    });
  });

  it("normalizes bare handles, @-handles and scheme-less URLs", () => {
    expect(normalizeSocialUrl("handle", "twitter")).to.equal(
      "https://x.com/handle"
    );
    expect(normalizeSocialUrl("@handle", "twitter")).to.equal(
      "https://x.com/handle"
    );
    expect(normalizeSocialUrl("x.com/handle", "twitter")).to.equal(
      "https://x.com/handle"
    );
    expect(normalizeSocialUrl("https://twitter.com/handle", "twitter")).to.equal(
      "https://twitter.com/handle"
    );
    expect(normalizeSocialUrl("t.me/group", "telegram")).to.equal(
      "https://t.me/group"
    );
    expect(normalizeSocialUrl("@group", "telegram")).to.equal(
      "https://t.me/group"
    );
    expect(normalizeSocialUrl("", "twitter")).to.equal("");
    expect(normalizeWebsiteUrl("example.com")).to.equal("https://example.com");
    expect(normalizeWebsiteUrl("https://example.com")).to.equal(
      "https://example.com"
    );
  });

  it("describeMetadataProblems flags missing name/symbol and over-long fields", () => {
    expect(
      describeMetadataProblems({
        name: "",
        symbol: "",
        description: "",
        website: "",
        twitter: "",
        telegram: "",
      })
    ).to.have.length(2);
    expect(describeMetadataProblems(FIELDS)).to.have.length(0);
    const long = "a".repeat(1001);
    const problems = describeMetadataProblems({
      ...FIELDS,
      description: long,
      website: "x".repeat(201),
    });
    expect(problems.join("; ")).to.contain("description too long");
    expect(problems.join("; ")).to.contain("website too long");
  });

  it("assertUriFitsOnChain enforces the program's 200-byte uri cap", () => {
    assertUriFitsOnChain("https://meta.example.com/abc/metadata.json"); // ok
    expect(() => assertUriFitsOnChain(`https://${"a".repeat(220)}/m.json`)).to.throw(
      /uri too long/
    );
  });

  it("sanitizes image filenames and gates image types", () => {
    expect(sanitizeImageFilename("../../evil.png", "image/png")).to.equal(
      "evil.png"
    );
    expect(sanitizeImageFilename("My Coin Art!.png", "image/png")).to.match(
      /\.png$/
    );
    expect(isAllowedImageType("image/png")).to.equal(true);
    expect(isAllowedImageType("image/avif")).to.equal(false);
  });
});

describe("backend env resolution", () => {
  it("returns null with a reason when nothing is configured", () => {
    const r = resolveMetadataBackendFromEnv({});
    if (r.backend) throw new Error("expected no backend");
    expect(r.reason).to.contain("METADATA_VPS_UPLOAD_URL");
  });

  it("auto-picks vps when METADATA_VPS_* is fully set", () => {
    const r = resolveMetadataBackendFromEnv({
      METADATA_VPS_UPLOAD_URL: "https://m.example.com/put",
      METADATA_VPS_BASE_URL: "https://m.example.com",
      METADATA_VPS_SECRET: "x",
    });
    if (!r.backend) throw new Error("expected vps backend");
    expect(r.backend.id).to.equal("vps");
    expect(r.backend.vps?.secret).to.equal("x");
  });

  it("auto-picks ipfs when only PINATA_JWT is set", () => {
    const r = resolveMetadataBackendFromEnv({ PINATA_JWT: "jwt" });
    if (!r.backend) throw new Error("expected ipfs backend");
    expect(r.backend.id).to.equal("ipfs");
    expect(r.backend.ipfs?.gateway).to.equal("https://ipfs.io/ipfs");
  });

  it("METADATA_BACKEND=ipfs wins when both are configured", () => {
    const r = resolveMetadataBackendFromEnv({
      METADATA_BACKEND: "ipfs",
      METADATA_VPS_UPLOAD_URL: "u",
      METADATA_VPS_BASE_URL: "b",
      METADATA_VPS_SECRET: "s",
      PINATA_JWT: "jwt",
    });
    if (!r.backend) throw new Error("expected ipfs backend");
    expect(r.backend.id).to.equal("ipfs");
  });

  it("METADATA_BACKEND=vps without the vps env is a null with reason", () => {
    const r = resolveMetadataBackendFromEnv({ METADATA_BACKEND: "vps" });
    if (r.backend) throw new Error("expected no backend");
    expect(r.reason).to.contain("METADATA_BACKEND=vps");
  });
});

describe("vps backend dialect (mock fetch)", () => {
  it("PUTs the image then the JSON, returns base-URL'd uri + imageUrl", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = mockFetch(calls, () => jsonResponse(200, { ok: true }));
    const result = await publishTokenMetadataBundle({
      fields: FIELDS,
      image: IMAGE,
      config: VPS_CONFIG,
      fetchImpl,
    });
    expect(calls).to.have.length(2);
    // Image first (the JSON must reference the real image URL).
    const img = calls[0];
    const json = calls[1];
    const imgPath = new URL(img.url).searchParams.get("path") ?? "";
    const jsonPath = new URL(json.url).searchParams.get("path") ?? "";
    expect(imgPath).to.match(/^[a-f0-9]+\/coin\.png$/);
    expect(jsonPath).to.match(/^[a-f0-9]+\/metadata\.json$/);
    expect(new URL(img.url).pathname).to.equal("/put");
    for (const c of calls) {
      const headers = (c.init?.headers ?? {}) as Record<string, string>;
      expect(headers["x-metadata-secret"]).to.equal("s3cret");
    }
    expect((img.init?.headers as Record<string, string>)["content-type"]).to.equal(
      "image/png"
    );
    expect((json.init?.headers as Record<string, string>)["content-type"]).to.equal(
      "application/json"
    );
    // Image body is the exact raw bytes; JSON body is the composed metadata.
    expect([...bodyBytes(img.init)]).to.deep.equal([...IMAGE.bytes]);
    const parsed = JSON.parse(String(json.init?.body)) as Record<string, unknown>;
    expect(parsed.name).to.equal("M9 Test Coin");
    expect(parsed.image).to.equal(result.imageUrl);
    expect(parsed.twitter).to.equal("https://x.com/m9test");
    expect(result.uri).to.match(
      /^https:\/\/meta\.example\.com\/[a-f0-9]+\/metadata\.json$/
    );
    expect(result.imageUrl).to.match(
      /^https:\/\/meta\.example\.com\/[a-f0-9]+\/coin\.png$/
    );
    // Both share one id directory.
    const id = imgPath.split("/")[0];
    expect(jsonPath.split("/")[0]).to.equal(id);
  });

  it("omits the image leg and the image JSON key when no image is given", async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = mockFetch(calls, () => jsonResponse(200, { ok: true }));
    const result = await publishTokenMetadataBundle({
      fields: FIELDS,
      image: null,
      config: VPS_CONFIG,
      fetchImpl,
    });
    expect(calls).to.have.length(1);
    const parsed = JSON.parse(String(calls[0].init?.body)) as Record<string, unknown>;
    expect(parsed.image).to.equal(undefined);
    expect(result.imageUrl).to.equal(undefined);
  });

  it("surfaces vps HTTP errors with the status", async () => {
    const fetchImpl = mockFetch([], () => jsonResponse(401, { error: "nope" }));
    await expectRejects(
      publishTokenMetadataBundle({
        fields: FIELDS,
        image: null,
        config: VPS_CONFIG,
        fetchImpl,
      }),
      /metadata vps upload failed \(HTTP 401\)/
    );
  });

  it("rejects a uri over the on-chain 200-byte cap", async () => {
    const longBase: MetadataBackendConfig = {
      id: "vps",
      vps: {
        uploadUrl: `https://${"a".repeat(200)}.example.com/put`,
        baseUrl: `https://${"a".repeat(200)}.example.com`,
        secret: "s",
      },
    };
    const fetchImpl = mockFetch([], () => jsonResponse(200, { ok: true }));
    await expectRejects(
      publishTokenMetadataBundle({
        fields: FIELDS,
        image: null,
        config: longBase,
        fetchImpl,
      }),
      /uri too long/
    );
  });
});

describe("ipfs (Pinata) backend dialect (mock fetch)", () => {
  const IPFS_CONFIG: MetadataBackendConfig = {
    id: "ipfs",
    ipfs: { jwt: "jwt-123", gateway: "https://ipfs.io/ipfs" },
  };

  it("pins the image via pinFileToIPFS then the JSON via pinJSONToIPFS", async () => {
    const calls: RecordedCall[] = [];
    let pinCount = 0;
    const fetchImpl = mockFetch(calls, () => {
      pinCount += 1;
      return pinCount === 1
        ? jsonResponse(200, { IpfsHash: "QmImgHash" })
        : jsonResponse(200, { IpfsHash: "QmJsonHash" });
    });
    const result = await publishTokenMetadataBundle({
      fields: FIELDS,
      image: IMAGE,
      config: IPFS_CONFIG,
      fetchImpl,
    });
    expect(calls).to.have.length(2);
    const [img, json] = calls;
    expect(img.url).to.equal("https://api.pinata.cloud/pinning/pinFileToIPFS");
    expect(json.url).to.equal("https://api.pinata.cloud/pinning/pinJSONToIPFS");
    for (const c of calls) {
      const headers = (c.init?.headers ?? {}) as Record<string, string>;
      expect(headers["authorization"]).to.equal("Bearer jwt-123");
    }
    const meta = (img.init?.body as FormData).get("pinataMetadata");
    expect(String(meta)).to.contain("coin.png");
    const payload = JSON.parse(String(json.init?.body)) as {
      pinataContent: Record<string, unknown>;
    };
    expect(payload.pinataContent.name).to.equal("M9 Test Coin");
    expect(payload.pinataContent.image).to.equal(
      "https://ipfs.io/ipfs/QmImgHash"
    );
    expect(result.uri).to.equal("https://ipfs.io/ipfs/QmJsonHash");
    expect(result.imageUrl).to.equal("https://ipfs.io/ipfs/QmImgHash");
  });

  it("surfaces pinata errors with the response text", async () => {
    const fetchImpl = mockFetch(
      [],
      () => jsonResponse(403, { error: "forbidden" })
    );
    await expectRejects(
      publishTokenMetadataBundle({
        fields: FIELDS,
        image: null,
        config: IPFS_CONFIG,
        fetchImpl,
      }),
      /pinata pinJSONToIPFS failed \(HTTP 403\)/
    );
  });
});
