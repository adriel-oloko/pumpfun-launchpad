// Milestone M9: metadata publish ENGINE (server-side).
//
// Mirrors the M7b relay layering: lib/metadata.ts holds the pure builders +
// client helper, this file holds the upload engine that talks to the two
// supported backends, and app/api/metadata/publish/route.ts is a thin
// wrapper. The engine is pure: fetch is INJECTED so the vps and ipfs
// dialects are provable with mock fetch (see tests/pumpfun-metadata.ts) —
// this repo holds neither a VPS secret nor a Pinata JWT, and no live test
// replaces those mocks.
//
// Backend selection (server env, resolved by resolveMetadataBackendFromEnv):
//   METADATA_BACKEND=vps|ipfs  (explicit; default picks vps when
//                               METADATA_VPS_* is fully set, else ipfs when
//                               PINATA_JWT is set)
//   vps : METADATA_VPS_UPLOAD_URL (the receiver's /put endpoint, see
//         tools/metadata-vps/server.mjs), METADATA_VPS_BASE_URL (public
//         origin that serves the files), METADATA_VPS_SECRET (shared secret).
//         The engine PUTs the raw image and the raw metadata.json bytes;
//         the receiver is a dumb file store (no metadata logic).
//   ipfs: PINATA_JWT (Pinata API key) + optional PINATA_GATEWAY (default
//         https://ipfs.io/ipfs). Image via pinFileToIPFS (multipart), JSON
//         via pinJSONToIPFS; the returned CID is served through the gateway.
//
// Mainnet answer (user asked vps or ipfs): VPS primary — the operator owns
// the box (already paid for, no recurring pinning bill, image + JSON
// colocated under one stable URL). Single-host risk is real because the
// on-chain uri is immutable, so the operator should ALSO archive each
// token's JSON + image to IPFS/Arweave at launch. The engine keeps ipfs as
// a switchable second backend for that mirror or as the primary when the
// operator prefers a pinning service.

import {
  assertUriFitsOnChain,
  buildTokenMetadataJson,
  type TokenMetadataFields,
} from "./metadata";

export type MetadataBackendId = "vps" | "ipfs";

export interface VpsBackendConfig {
  uploadUrl: string;
  baseUrl: string;
  secret: string;
}

export interface IpfsBackendConfig {
  jwt: string;
  gateway: string;
}

export interface MetadataBackendConfig {
  id: MetadataBackendId;
  vps?: VpsBackendConfig;
  ipfs?: IpfsBackendConfig;
}

export interface ImageUpload {
  filename: string;
  contentType: string;
  bytes: Uint8Array;
}

export interface MetadataPublishBundleInput {
  fields: TokenMetadataFields;
  image?: ImageUpload | null;
  config: MetadataBackendConfig;
  fetchImpl?: typeof fetch;
}

export interface MetadataPublishBundleResult {
  uri: string;
  imageUrl?: string;
}

/** Image byte cap enforced by the route (env METADATA_MAX_IMAGE_BYTES
 *  overrides in the route). 5 MiB keeps launchpanels sane and the upload
 *  fast; token art is a PNG/JPEG/WebP, not a 4K video. */
export const METADATA_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const METADATA_JSON_MAX_BYTES = 64 * 1024;

const ALLOWED_IMAGE_TYPES = new Set([
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
  "image/svg+xml",
]);

const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
};

export function isAllowedImageType(contentType: string): boolean {
  return ALLOWED_IMAGE_TYPES.has(contentType.toLowerCase());
}

/** Server-side filename sanitize: keep the original name when it is safe,
 *  otherwise fall back to the content-type extension. The receiver refuses
 *  path traversal, but defense in depth costs one line. */
export function sanitizeImageFilename(
  filename: string,
  contentType: string
): string {
  const ext = IMAGE_EXT[contentType.toLowerCase()] ?? "png";
  const base = filename
    .replace(/\\/g, "/")
    .split("/")
    .pop() ?? "image";
  const clean = base
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^[.-]+|[.-]+$/g, "")
    .slice(0, 60);
  const name = clean || "image";
  return name.endsWith(`.${ext}`) ? name : `${name}.${ext}`;
}

/** Picks the metadata backend from server env. Returns a concrete config
 *  when one is fully configured, else null with the reason (the route turns
 *  that into a 501 the panel can surface as "configure a backend or use the
 *  manual metadata URI"). */
export function resolveMetadataBackendFromEnv(
  env: Record<string, string | undefined>
):
  | { backend: MetadataBackendConfig }
  | { backend: null; reason: string } {
  const pick = (env.METADATA_BACKEND ?? "").trim().toLowerCase();
  const vpsReady = Boolean(
    env.METADATA_VPS_UPLOAD_URL &&
      env.METADATA_VPS_BASE_URL &&
      env.METADATA_VPS_SECRET
  );
  const ipfsReady = Boolean(env.PINATA_JWT);

  if (pick === "vps") {
    if (!vpsReady) {
      return {
        backend: null,
        reason:
          "METADATA_BACKEND=vps but METADATA_VPS_UPLOAD_URL / METADATA_VPS_BASE_URL / METADATA_VPS_SECRET are not all set",
      };
    }
    return {
      backend: {
        id: "vps",
        vps: {
          uploadUrl: env.METADATA_VPS_UPLOAD_URL as string,
          baseUrl: env.METADATA_VPS_BASE_URL as string,
          secret: env.METADATA_VPS_SECRET as string,
        },
      },
    };
  }
  if (pick === "ipfs") {
    if (!ipfsReady) {
      return {
        backend: null,
        reason: "METADATA_BACKEND=ipfs but PINATA_JWT is not set",
      };
    }
    return {
      backend: {
        id: "ipfs",
        ipfs: {
          jwt: env.PINATA_JWT as string,
          gateway: (env.PINATA_GATEWAY ?? "https://ipfs.io/ipfs").replace(
            /\/+$/,
            ""
          ),
        },
      },
    };
  }
  if (vpsReady) {
    return {
      backend: {
        id: "vps",
        vps: {
          uploadUrl: env.METADATA_VPS_UPLOAD_URL as string,
          baseUrl: env.METADATA_VPS_BASE_URL as string,
          secret: env.METADATA_VPS_SECRET as string,
        },
      },
    };
  }
  if (ipfsReady) {
    return {
      backend: {
        id: "ipfs",
        ipfs: {
          jwt: env.PINATA_JWT as string,
          gateway: (env.PINATA_GATEWAY ?? "https://ipfs.io/ipfs").replace(
            /\/+$/,
            ""
          ),
        },
      },
    };
  }
  return {
    backend: null,
    reason:
      "no metadata backend configured: set METADATA_BACKEND=vps + METADATA_VPS_UPLOAD_URL/METADATA_VPS_BASE_URL/METADATA_VPS_SECRET, or METADATA_BACKEND=ipfs + PINATA_JWT (server env, not NEXT_PUBLIC_)",
  };
}

function randomId(): string {
  const c = globalThis.crypto as
    | { randomUUID?: () => string }
    | undefined;
  if (c && typeof c.randomUUID === "function") {
    return c.randomUUID().replace(/-/g, "").slice(0, 12);
  }
  return (
    Math.random().toString(36).slice(2, 10) + Date.now().toString(36)
  );
}

function joinUrl(base: string, ...segs: string[]): string {
  return [base.replace(/\/+$/, ""), ...segs.map((s) => s.replace(/^\/+/, ""))].join(
    "/"
  );
}

/** A standalone ArrayBuffer holding an exact copy of the bytes. Needed
 *  because TS 5.7's generic typed arrays type `Uint8Array` as
 *  `Uint8Array<ArrayBufferLike>`, which fetch bodies and Blob parts reject
 *  (they want an `ArrayBuffer`, not a possibly-shared view); slicing the
 *  underlying buffer yields a plain `ArrayBuffer` in every lib version and
 *  also drops any non-zero byteOffset the view started at. */
function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

async function textOf(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 300);
  } catch {
    return "(unreadable response body)";
  }
}

async function vpsPut(
  fetchImpl: typeof fetch,
  cfg: VpsBackendConfig,
  path: string,
  contentType: string,
  body: string | Uint8Array
): Promise<void> {
  const payload: string | ArrayBuffer =
    typeof body === "string" ? body : toArrayBuffer(body);
  const res = await fetchImpl(
    `${cfg.uploadUrl.replace(/\/+$/, "")}?path=${encodeURIComponent(path)}`,
    {
      method: "PUT",
      headers: {
        "x-metadata-secret": cfg.secret,
        "content-type": contentType,
      },
      body: payload,
    }
  );
  if (!res.ok) {
    throw new Error(
      `metadata vps upload failed (HTTP ${res.status}): ${await textOf(res)}`
    );
  }
}

async function pinataPinFile(
  fetchImpl: typeof fetch,
  jwt: string,
  image: ImageUpload
): Promise<string> {
  const fd = new FormData();
  fd.append(
    "file",
    new Blob([toArrayBuffer(image.bytes)], { type: image.contentType }),
    image.filename
  );
  fd.append("pinataMetadata", JSON.stringify({ name: image.filename }));
  const res = await fetchImpl(
    "https://api.pinata.cloud/pinning/pinFileToIPFS",
    {
      method: "POST",
      headers: { authorization: `Bearer ${jwt}` },
      body: fd,
    }
  );
  const text = await textOf(res);
  if (!res.ok) {
    throw new Error(`pinata pinFileToIPFS failed (HTTP ${res.status}): ${text}`);
  }
  let j: { IpfsHash?: string };
  try {
    j = JSON.parse(text) as { IpfsHash?: string };
  } catch {
    throw new Error(`pinata pinFileToIPFS returned non-JSON: ${text}`);
  }
  if (!j.IpfsHash) {
    throw new Error("pinata pinFileToIPFS returned no IpfsHash");
  }
  return j.IpfsHash;
}

async function pinataPinJson(
  fetchImpl: typeof fetch,
  jwt: string,
  name: string,
  content: unknown
): Promise<string> {
  const res = await fetchImpl(
    "https://api.pinata.cloud/pinning/pinJSONToIPFS",
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        pinataContent: content,
        pinataMetadata: { name },
      }),
    }
  );
  const text = await textOf(res);
  if (!res.ok) {
    throw new Error(`pinata pinJSONToIPFS failed (HTTP ${res.status}): ${text}`);
  }
  let j: { IpfsHash?: string };
  try {
    j = JSON.parse(text) as { IpfsHash?: string };
  } catch {
    throw new Error(`pinata pinJSONToIPFS returned non-JSON: ${text}`);
  }
  if (!j.IpfsHash) {
    throw new Error("pinata pinJSONToIPFS returned no IpfsHash");
  }
  return j.IpfsHash;
}

/** Publishes one token's metadata bundle to the configured backend and
 *  returns the final on-chain uri (+ image URL when an image was uploaded).
 *  Order matters: the image is uploaded/pinned FIRST so the JSON's image
 *  field can point at the real served URL. The returned uri is asserted to
 *  fit the program's 200-byte create() cap before it is handed back. */
export async function publishTokenMetadataBundle(
  input: MetadataPublishBundleInput
): Promise<MetadataPublishBundleResult> {
  const fetchImpl =
    input.fetchImpl ??
    ((globalThis as { fetch?: typeof fetch }).fetch as typeof fetch);
  if (typeof fetchImpl !== "function") {
    throw new Error("no fetch implementation available");
  }
  const { fields, image, config } = input;

  if (config.id === "vps") {
    const cfg = config.vps;
    if (!cfg) throw new Error("metadata backend misconfigured: vps config missing");
    const id = randomId();
    let imageUrl: string | undefined;
    if (image) {
      const filename = sanitizeImageFilename(image.filename, image.contentType);
      await vpsPut(
        fetchImpl,
        cfg,
        `${id}/${filename}`,
        image.contentType,
        image.bytes
      );
      imageUrl = joinUrl(cfg.baseUrl, id, filename);
    }
    const json = buildTokenMetadataJson({ ...fields, imageUrl: imageUrl ?? "" });
    const jsonString = JSON.stringify(json);
    if (new TextEncoder().encode(jsonString).byteLength > METADATA_JSON_MAX_BYTES) {
      throw new Error(
        `metadata JSON over the ${METADATA_JSON_MAX_BYTES}-byte cap`
      );
    }
    await vpsPut(fetchImpl, cfg, `${id}/metadata.json`, "application/json", jsonString);
    const uri = joinUrl(cfg.baseUrl, id, "metadata.json");
    assertUriFitsOnChain(uri);
    return { uri, imageUrl };
  }

  if (config.id === "ipfs") {
    const cfg = config.ipfs;
    if (!cfg) throw new Error("metadata backend misconfigured: ipfs config missing");
    let imageUrl: string | undefined;
    if (image) {
      const hash = await pinataPinFile(fetchImpl, cfg.jwt, image);
      imageUrl = `${cfg.gateway}/${hash}`;
    }
    const json = buildTokenMetadataJson({ ...fields, imageUrl: imageUrl ?? "" });
    const jsonString = JSON.stringify(json);
    if (new TextEncoder().encode(jsonString).byteLength > METADATA_JSON_MAX_BYTES) {
      throw new Error(
        `metadata JSON over the ${METADATA_JSON_MAX_BYTES}-byte cap`
      );
    }
    const hash = await pinataPinJson(fetchImpl, cfg.jwt, "metadata.json", json);
    const uri = `${cfg.gateway}/${hash}`;
    assertUriFitsOnChain(uri);
    return { uri, imageUrl };
  }

  throw new Error(`unknown metadata backend: ${String((config as { id?: unknown }).id)}`);
}
