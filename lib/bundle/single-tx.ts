// Single-transaction launch: pump.fun create + ONE buy + the relay tip packed
// into a single versioned (V0) transaction, submitted to NextBlock's SINGLE
// /api/v2/submit endpoint (NOT the 2-4 tx submit-batch bundle).
//
// WHY: the free NextBlock tier is 1 TX / 10s and submit-batch requires 2-4
// txs, so a single-tx launch is the cheapest way to exercise the full
// create+buy path without the bundle floor or a multi-tx fee spend. A launch
// that lands in one tx also needs no atomicity guarantee (there is nothing to
// half-land).
//
// SIZE: the upgraded create (16 accounts) + buy (18 accounts) + tip together
// exceed the legacy 1232-byte limit, so the tx is a V0 message that indexes
// the constant pump.fun accounts through the shared address lookup table
// (ALT, see lookup.ts). The per-launch accounts (mint, curve, creator, buyer,
// the tip wallet, their PDAs/ATAs) stay inline as full pubkeys.
//
// The buying wallet MUST already hold SOL: there is no room for a funding
// transfer inside the same tx, and the buy's max_sol_cost + fees + the
// post-buy rent floor must be covered by the buyer's existing balance.

import {
  ComputeBudgetProgram,
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { Buffer } from "buffer";
import {
  buildPumpBuyIx,
  buildPumpCreateIx,
  quotePumpBuy,
  resolvePumpFeeRecipient,
} from "../pump";
import { VIRTUAL_SOL_RESERVE, VIRTUAL_TOKEN_RESERVE } from "../params";
import { DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS } from "../fees";
import { MAX_TX_BYTES, deriveLaunchPdas } from "./launch";

/** Combined compute-unit budget: create ~111k + buy (incl. ATA create + tip)
 *  ~205k, rounded up with headroom. One tx, so no Jito cost-model concern. */
export const SINGLE_TX_CU_LIMIT = 500_000;

export interface SingleTxLaunchOptions {
  connection: Connection;
  creator: Keypair;
  name: string;
  symbol: string;
  uri: string;
  /** The buyer. Defaults to the creator (a self-buy, the minimal single-tx
   *  launch). Must already hold enough SOL for its own buy + fees + rent. */
  buyer?: Keypair;
  /** SOL (lamports) the buyer sends into the curve. */
  solInLamports: bigint;
  /** NextBlock tip account (an entry of KNOWN_NEXTBLOCK_TIP_ACCOUNTS). */
  tipAccount: PublicKey;
  /** Tip lamports (NextBlock floor is 1_000_000 = 0.001 SOL). */
  tipLamports: number;
  /** The shared pump.fun ALT: live (ensurePumpLookupTable) for execution, or
   *  a synthetic one (syntheticPumpLookupTable) for a dry-run size check. */
  alt: AddressLookupTableAccount;
  priorityFeeMicroLamports?: number;
}

export interface SingleTxLaunch {
  tx: VersionedTransaction;
  /** base64 of the signed V0 tx, ready for /api/v2/submit. */
  base64: string;
  mint: PublicKey;
  mintKeypair: Keypair;
  curveState: PublicKey;
  sizeBytes: number;
}

/** Builds the signed single-tx launch (create + one buy + tip). Throws if the
 *  serialized tx exceeds the 1232-byte limit (name/uri too long or buy amount
 *  too large). The input keypairs are never mutated; the mint keypair is
 *  freshly generated and returned so the caller can retain it. */
export async function buildSingleTxLaunch(
  opts: SingleTxLaunchOptions
): Promise<SingleTxLaunch> {
  const {
    connection,
    creator,
    name,
    symbol,
    uri,
    solInLamports,
    tipAccount,
    tipLamports,
    alt,
  } = opts;
  const buyer = opts.buyer ?? creator;
  if (solInLamports <= BigInt(0)) {
    throw new Error("solInLamports must be positive");
  }
  if (tipLamports < 1_000_000) {
    throw new Error(
      `tipLamports ${tipLamports} below the 0.001 SOL NextBlock floor`
    );
  }

  const mintKeypair = Keypair.generate();
  const mint = mintKeypair.publicKey;
  const pda = deriveLaunchPdas(mint);
  const latest = await connection.getLatestBlockhash("confirmed");
  const feeRecipient = await resolvePumpFeeRecipient(connection);

  const quote = quotePumpBuy({
    solInLamports,
    virtualSolReserves: VIRTUAL_SOL_RESERVE,
    virtualTokenReserves: VIRTUAL_TOKEN_RESERVE,
  });

  const createIx = buildPumpCreateIx({
    creator: creator.publicKey,
    mint,
    name,
    symbol,
    uri,
  });
  const buyIxs = buildPumpBuyIx({
    mint,
    buyer: buyer.publicKey,
    creator: creator.publicKey,
    feeRecipient,
    tokensOut: quote.tokensOut,
    maxSolCost: quote.maxSolCost,
  });
  const tipIx = SystemProgram.transfer({
    fromPubkey: creator.publicKey,
    toPubkey: tipAccount,
    lamports: tipLamports,
  });

  const priorityFee =
    opts.priorityFeeMicroLamports ?? DEFAULT_PRIORITY_FEE_MICRO_LAMPORTS;
  const instructions = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: SINGLE_TX_CU_LIMIT }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }),
    createIx,
    ...buyIxs,
    tipIx,
  ];

  const message = new TransactionMessage({
    payerKey: creator.publicKey,
    recentBlockhash: latest.blockhash,
    instructions,
  }).compileToV0Message([alt]);

  const tx = new VersionedTransaction(message);
  const signers = buyer.publicKey.equals(creator.publicKey)
    ? [creator, mintKeypair]
    : [creator, mintKeypair, buyer];
  tx.sign(signers);

  const bytes = tx.serialize();
  if (bytes.length > MAX_TX_BYTES) {
    throw new Error(
      `single-tx launch serialized to ${bytes.length} bytes > the ${MAX_TX_BYTES}-byte limit; shorten name/uri or reduce the buy amount`
    );
  }
  return {
    tx,
    base64: Buffer.from(bytes).toString("base64"),
    mint,
    mintKeypair,
    curveState: pda.curveState,
    sizeBytes: bytes.length,
  };
}

export interface NextBlockSingleSubmitOptions {
  base64: string;
  apiKey: string;
  /** Region base host (default https://ny.nextblock.io). */
  baseUrl?: string;
  skipPreFlight?: boolean;
  frontRunningProtection?: boolean;
  fetchFn?: typeof fetch;
}

/** Submits ONE signed tx to NextBlock's single-submit endpoint
 *  POST /api/v2/submit. Returns the tx signature on 200 `{signature}`; throws
 *  with the relay's `message`+`code` on any error. */
export async function submitSingleTxToNextBlock(
  opts: NextBlockSingleSubmitOptions
): Promise<{ signature: string; uuid?: string }> {
  const base = (opts.baseUrl ?? "https://ny.nextblock.io").replace(/\/+$/, "");
  const url = `${base}/api/v2/submit`;
  const fetchFn =
    opts.fetchFn ?? ((globalThis as { fetch: typeof fetch }).fetch);
  const res = await fetchFn(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      authorization: opts.apiKey,
    },
    body: JSON.stringify({
      transaction: { content: opts.base64 },
      skipPreFlight: opts.skipPreFlight ?? true,
      frontRunningProtection: opts.frontRunningProtection ?? false,
      disableRetries: false,
      revertOnFail: false,
      snipeTransaction: false,
    }),
  });
  const raw = await res.text();
  let json: { signature?: string; uuid?: string; message?: string; code?: number } | null =
    null;
  try {
    json = JSON.parse(raw);
  } catch {
    // non-JSON error body: fall through to the http-status detail
  }
  if (res.ok && json?.signature) {
    return { signature: json.signature, uuid: json.uuid };
  }
  const detail = json?.message
    ? `${json.message}${json.code != null ? ` (code ${json.code})` : ""}`
    : `http ${res.status}: ${raw.slice(0, 200)}`;
  throw new Error(`NextBlock single submit failed: ${detail}`);
}
