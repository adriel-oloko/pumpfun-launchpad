// Milestone M9: structured token metadata + publish-on-launch.
//
// The launch panel's single "metadata URI" field is replaced by discrete
// description / image / social inputs. On launch the client posts the
// composed fields to /api/metadata/publish (same-origin), the server uploads
// the metadata JSON (and the image file when one was picked) to the
// configured backend, and the returned URL becomes the create() uri argument
// (still a plain <=200-byte string stored verbatim in the mpl metadata
// account; the image + socials live INSIDE the JSON at that URL, standard
// pump.fun-style off-chain metadata).
//
// This file is BROWSER + SERVER safe: it is imported by
// components/launch-panel.tsx AND (via lib/metadata-publish.ts) by the
// publish route. It holds only pure builders and the client publish helper.
// The server upload engine (vps / ipfs dialects) lives in
// lib/metadata-publish.ts and is deliberately never imported by client code.
//
// JSON shape (pump.fun-style, superset of the Metaplex off-chain standard):
//   { name, symbol, description, image, website, external_url, twitter,
//     telegram }  -- empty optional fields are OMITTED, never "".

/** Structured metadata fields captured by the launch panel form. */
export interface TokenMetadataFields {
  name: string
  symbol: string
  description: string
  website: string
  twitter: string
  telegram: string
}

export const MAX_DESCRIPTION_CHARS = 1000;
export const MAX_SOCIAL_URL_CHARS = 200;

function byteLengthUtf8(s: string): number {
  return new TextEncoder().encode(s).byteLength;
}

/** The program's create() arg cap: name 32 / symbol 10 / uri 200 bytes
 *  (programs/pumpfun/src/lib.rs MAX_*_LEN). Throws with the byte counts so
 *  an operator sees exactly how far over they are. */
export function assertUriFitsOnChain(uri: string): void {
  const bytes = byteLengthUtf8(uri);
  if (bytes > 200) {
    throw new Error(
      `uri too long (${bytes} > 200 bytes). Shorten the metadata backend base URL or the path.`
    );
  }
}

function withScheme(v: string): string {
  return /^https?:\/\//i.test(v) ? v : `https://${v}`;
}

/** Website: empty stays empty; a bare domain/URL without a scheme gets
 *  https:// prefixed. */
export function normalizeWebsiteUrl(raw: string): string {
  const v = raw.trim();
  if (!v) return "";
  return withScheme(v);
}

/** Social link: empty stays empty; a full http(s) URL is kept; a bare
 *  handle ("handle", "@handle") becomes the canonical profile URL; a
 *  scheme-less path ("x.com/handle", "t.me/group") gets https://. */
export function normalizeSocialUrl(
  raw: string,
  kind: "twitter" | "telegram"
): string {
  const v = raw.trim();
  if (!v) return "";
  if (/^https?:\/\//i.test(v)) return v;
  const handle = v.replace(/^@+/, "");
  if (!handle) return "";
  const base = kind === "twitter" ? "https://x.com/" : "https://t.me/";
  // Looks like a path (contains a dot and/or a slash): the user typed a URL
  // without the scheme. Keep it as-is with https://.
  if (/[./]/.test(handle)) return withScheme(handle);
  return `${base}${encodeURIComponent(handle)}`;
}

/** Composes the pump.fun-style off-chain metadata JSON. Optional fields are
 *  omitted when empty; website is mirrored into the Metaplex-standard
 *  external_url field. Image lives INSIDE the JSON (the on-chain uri just
 *  points here, and explorers render the image from this field). */
export function buildTokenMetadataJson(
  fields: TokenMetadataFields & { imageUrl?: string }
): Record<string, unknown> {
  const json: Record<string, unknown> = {
    name: fields.name,
    symbol: fields.symbol,
  };
  const description = fields.description.trim();
  if (description) json.description = description;
  const imageUrl = (fields.imageUrl ?? "").trim();
  if (imageUrl) json.image = imageUrl;
  const website = normalizeWebsiteUrl(fields.website);
  if (website) {
    json.website = website;
    json.external_url = website;
  }
  const twitter = normalizeSocialUrl(fields.twitter, "twitter");
  if (twitter) json.twitter = twitter;
  const telegram = normalizeSocialUrl(fields.telegram, "telegram");
  if (telegram) json.telegram = telegram;
  return json;
}

/** Human-readable problems with the structured fields (empty when fine).
 *  Used by the panel for pre-launch UX and by the publish route for fast
 *  400s. Length caps are generous: the JSON has no on-chain byte limit, but
 *  keeping it sane bounds the upload and the explorer render. */
export function describeMetadataProblems(
  fields: TokenMetadataFields
): string[] {
  const problems: string[] = [];
  if (!fields.name.trim()) problems.push("token name is required");
  if (!fields.symbol.trim()) problems.push("token symbol is required");
  if (byteLengthUtf8(fields.description) > MAX_DESCRIPTION_CHARS) {
    problems.push(
      `description too long (${byteLengthUtf8(fields.description)} > ${MAX_DESCRIPTION_CHARS} chars)`
    );
  }
  for (const [label, value] of [
    ["website", fields.website],
    ["twitter", fields.twitter],
    ["telegram", fields.telegram],
  ] as const) {
    if (byteLengthUtf8(value) > MAX_SOCIAL_URL_CHARS) {
      problems.push(`${label} too long (> ${MAX_SOCIAL_URL_CHARS} chars)`);
    }
  }
  return problems;
}

/** Client publish helper (launch panel). Posts the structured fields as
 *  multipart form data to the same-origin /api/metadata/publish route, which
 *  holds the backend credentials server-side. Throws the server's error
 *  text so the panel's friendly-error path maps it. */
export interface MetadataPublishResult {
  uri: string;
  imageUrl?: string;
  backend: string;
}

export async function publishTokenMetadata(args: {
  name: string;
  symbol: string;
  description: string;
  website: string;
  twitter: string;
  telegram: string;
  image?: File | null;
}): Promise<MetadataPublishResult> {
  const problems = describeMetadataProblems(args);
  if (problems.length) throw new Error(problems.join("; "));
  const fd = new FormData();
  fd.append("name", args.name);
  fd.append("symbol", args.symbol);
  fd.append("description", args.description);
  fd.append("website", args.website);
  fd.append("twitter", args.twitter);
  fd.append("telegram", args.telegram);
  if (args.image) fd.append("image", args.image, args.image.name);
  const res = await fetch("/api/metadata/publish", {
    method: "POST",
    body: fd,
    // AbortSignal.timeout is browser + node 18+; a stuck metadata upload
    // must never hang a launch.
    signal: AbortSignal.timeout(45_000),
  });
  const body = (await res.json().catch(() => ({}))) as Partial<
    MetadataPublishResult
  > & { error?: string };
  if (!res.ok) {
    throw new Error(
      body.error || `metadata publish failed (HTTP ${res.status})`
    );
  }
  return body as MetadataPublishResult;
}
