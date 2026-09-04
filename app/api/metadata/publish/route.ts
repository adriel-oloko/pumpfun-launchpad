// Milestone M9: metadata publish route (same-origin, thin wrapper).
//
// The Solana analog of the M7b bundle-relay split: the browser never holds
// backend credentials (a VPS shared secret or a Pinata JWT), so the launch
// panel posts the STRUCTURED metadata fields (multipart form data, image
// file optional) here and this route uploads the composed JSON + image to
// the configured backend, returning the final on-chain uri.
//
// BEHAVIOR (POST /api/metadata/publish, multipart/form-data):
//   fields  name, symbol, description, website, twitter, telegram (strings)
//   file    image (optional; image/*, <= METADATA_MAX_IMAGE_BYTES)
//   200     { uri, imageUrl?, backend }   uri fits the create() 200-byte cap
//   400     malformed fields / bad image
//   501     no metadata backend configured (server env) — the panel surfaces
//           the "configure a backend or enable manual metadata URI" hint
//   502     backend unreachable / upload failed
//
// The engine (lib/metadata-publish.ts) does the real work with an injected
// fetch, so the vps + ipfs dialects are unit-provable without live
// credentials (tests/pumpfun-metadata.ts). Env docs: .env.local.example.

import { NextResponse } from "next/server";
import { describeMetadataProblems, type TokenMetadataFields } from "../../../../lib/metadata";
import {
  isAllowedImageType,
  METADATA_MAX_IMAGE_BYTES,
  publishTokenMetadataBundle,
  resolveMetadataBackendFromEnv,
  type ImageUpload,
} from "../../../../lib/metadata-publish";

export const runtime = "nodejs";

const MAX_IMAGE_BYTES = Number(
  process.env.METADATA_MAX_IMAGE_BYTES || String(METADATA_MAX_IMAGE_BYTES)
);

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function field(form: FormData, key: string): string {
  const v = form.get(key);
  return typeof v === "string" ? v.trim() : "";
}

export async function POST(req: Request): Promise<NextResponse> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json(
      { error: "expected multipart/form-data" },
      { status: 400 }
    );
  }

  const fields: TokenMetadataFields = {
    name: field(form, "name"),
    symbol: field(form, "symbol"),
    description: field(form, "description"),
    website: field(form, "website"),
    twitter: field(form, "twitter"),
    telegram: field(form, "telegram"),
  };
  const problems = describeMetadataProblems(fields);
  if (problems.length > 0) {
    return NextResponse.json(
      { error: `invalid metadata fields: ${problems.join("; ")}` },
      { status: 400 }
    );
  }

  let image: ImageUpload | null = null;
  const rawImage = form.get("image");
  if (rawImage !== null && rawImage !== undefined) {
    if (!(rawImage instanceof File)) {
      return NextResponse.json(
        { error: "image field must be a file upload" },
        { status: 400 }
      );
    }
    if (!isAllowedImageType(rawImage.type)) {
      return NextResponse.json(
        { error: `unsupported image type ${rawImage.type || "(unknown)"}; use png/jpeg/gif/webp/svg` },
        { status: 400 }
      );
    }
    if (rawImage.size > MAX_IMAGE_BYTES) {
      return NextResponse.json(
        { error: `image over the ${MAX_IMAGE_BYTES}-byte cap` },
        { status: 413 }
      );
    }
    image = {
      filename: rawImage.name || "image",
      contentType: rawImage.type,
      bytes: new Uint8Array(await rawImage.arrayBuffer()),
    };
  }

  const resolved = resolveMetadataBackendFromEnv(process.env);
  if (!resolved.backend) {
    return NextResponse.json(
      {
        error:
          "METADATA BACKEND NOT CONFIGURED: " + resolved.reason +
          ". Either configure a backend in the server env or enable the manual metadata URI in the launch panel.",
      },
      { status: 501 }
    );
  }

  try {
    const result = await publishTokenMetadataBundle({
      fields,
      image,
      config: resolved.backend,
    });
    return NextResponse.json(
      {
        uri: result.uri,
        ...(result.imageUrl ? { imageUrl: result.imageUrl } : {}),
        backend: resolved.backend.id,
      },
      { status: 200 }
    );
  } catch (e) {
    return NextResponse.json(
      { error: `metadata publish failed: ${errText(e)}` },
      { status: 502 }
    );
  }
}
