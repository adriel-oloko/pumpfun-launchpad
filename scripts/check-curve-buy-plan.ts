// READ-ONLY check of the CURVE MAX buy wiring (no keys, no send: it BUILDS
// exactly what the manual Buy MAX / AUTO round would send and asserts the shape
// against a LIVE, not-yet-graduated curve).
//
// For a live curve it:
//   1. picks a mint whose curve is NOT graduated (arg, else auto-discovered
//      from recent pump program buys),
//   2. sizes a wallet's MAX budget with the manual rule (total balance minus
//      the flat 0.002 SOL keep, the base fee and the Token-2022 ATA rent),
//   3. builds the stream the buy goes through (quotePumpBuyExactIn +
//      buildPumpBuyExactSolInIx at CURVE_SLIPPAGE_BPS) and asserts:
//        - the AMM-side instruction IS buy_exact_sol_in (discriminator), NOT
//          the plain buy,
//        - spendable_sol_in IS the whole budget, min_tokens_out IS the banded
//          floor of the live quote,
//        - the account list is IDENTICAL to the proven `buy` instruction's,
//        - the serialized tx fits the 1232-byte legacy limit,
//   4. prints the counterfactual: the plain buy would have needed
//      max_sol_cost = budget * (1 + band), which the wallet does not hold.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/check-curve-buy-plan.ts [mint]

import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import { MAX_BUY_KEEP_SOL_LAMPORTS, CURVE_SLIPPAGE_BPS } from "../lib/params";
import {
  PUMP_BUY_DISCRIMINATOR,
  PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR,
  PUMP_PROGRAM_ID,
  buildPumpBuyExactSolInIx,
  buildPumpBuyIx,
  quotePumpBuy,
  quotePumpBuyExactIn,
  readPumpCurveState,
} from "../lib/pump";

const RPC =
  process.env.MAINNET_RPC ??
  "https://alien-billowing-voice.solana-mainnet.quiknode.pro/63ad5544cf41a4110f8a9bc5e8b2fa31420b620f";

/** The live balance the synthetic wallet is sized against (0.1 SOL). */
const LIVE_LAMPORTS = BigInt(100_000_000);
const MAX_TX_BYTES = 1232;
/** Token-2022 ATA (170 bytes) rent, read live below. */
const ATA_BYTES = 170;
/** The LIVE protocol fee recipient is resolved by the app; this probe only
 *  builds, so any pubkey works (the account list shape is what matters). */
const FEE_RECIPIENT = new PublicKey(
  "CebN5WGQ4jvEPvsVU4EoHEpgzq1VV7AbicfhtW4xC9iM"
);

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

/** A mint with a LIVE (not graduated, still decodable) curve: the arg, else the
 *  first usable mint among recent pump program transactions. */
async function findLiveCurveMint(
  connection: Connection
): Promise<PublicKey> {
  const sigs = await connection.getSignaturesForAddress(PUMP_PROGRAM_ID, {
    limit: 40,
  });
  const seen = new Set<string>();
  for (const s of sigs) {
    if (s.err) continue;
    const tx = await connection.getTransaction(s.signature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
    if (!tx) continue;
    const msg = tx.transaction.message;
    const statics =
      (msg as { staticAccountKeys?: PublicKey[] }).staticAccountKeys ??
      (msg as { accountKeys?: PublicKey[] }).accountKeys ??
      [];
    for (const ix of msg.compiledInstructions ?? []) {
      const pid = statics[ix.programIdIndex];
      if (!pid || !pid.equals(PUMP_PROGRAM_ID)) continue;
      const data = Buffer.from(ix.data);
      if (data.length < 8) continue;
      if (!data.subarray(0, 8).equals(Buffer.from(PUMP_BUY_DISCRIMINATOR)))
        continue;
      // account index 2 is `mint` in the buy layout.
      const mintKey = statics[ix.accountKeyIndexes[2]];
      if (!mintKey || seen.has(mintKey.toBase58())) continue;
      seen.add(mintKey.toBase58());
      const read = await readPumpCurveState(connection, mintKey);
      if (read.kind === "ok" && !read.curve.complete) return mintKey;
    }
  }
  throw new Error("no live (ungraduated) curve found in the recent sample");
}

async function main(): Promise<void> {
  const connection = new Connection(RPC, "confirmed");
  const mint = process.argv[2]
    ? new PublicKey(process.argv[2])
    : await findLiveCurveMint(connection);

  const read = await readPumpCurveState(connection, mint);
  assert(read.kind === "ok", "curve account missing for this mint");
  assert(
    read.kind === "ok" && !read.curve.complete,
    "curve is graduated: use scripts/check-pool-buy-plan.ts for the pool"
  );
  const curve = read.curve;
  console.log(`mint             ${mint.toBase58()} (curve complete = 0)`);
  console.log(
    `curve reserves   virtual sol ${curve.virtualSolReserves.toString()}, virtual tokens ${curve.virtualTokenReserves.toString()}, real tokens ${curve.realTokenReserves.toString()}`
  );
  console.log(`creator          ${curve.creator.toBase58()}`);

  const ataRent = await connection.getMinimumBalanceForRentExemption(
    ATA_BYTES,
    "confirmed"
  );
  const budget =
    LIVE_LAMPORTS -
    MAX_BUY_KEEP_SOL_LAMPORTS -
    BigInt(5_000) -
    BigInt(ataRent);
  console.log(
    `budget           ${budget} lamports of ${LIVE_LAMPORTS} live (keep 2000000 + fee 5000 + ATA rent ${ataRent})`
  );
  assert(budget > BigInt(0), "budget must be positive for a 0.1 SOL wallet");

  const buyer = Keypair.generate();
  const quote = quotePumpBuyExactIn({
    solInLamports: budget,
    virtualSolReserves: curve.virtualSolReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
    slippageBps: CURVE_SLIPPAGE_BPS,
  });
  console.log(
    `band             ${CURVE_SLIPPAGE_BPS} bps -> expects ${quote.tokensOut.toString()} raw tokens, floor ${quote.minTokensOut.toString()}`
  );

  const ixs = buildPumpBuyExactSolInIx({
    mint,
    buyer: buyer.publicKey,
    creator: curve.creator,
    feeRecipient: FEE_RECIPIENT,
    spendableSolIn: budget,
    minTokensOut: quote.minTokensOut,
  });
  assert(ixs.length === 2, `expected 2 instructions, got ${ixs.length}`);
  const buyIx = ixs[1];
  const data = Buffer.from(buyIx.data);
  const disc = Array.from(data.subarray(0, 8));
  const spendableArg = data.readBigUInt64LE(8);
  const minTokensArg = data.readBigUInt64LE(16);
  console.log(
    `buy ix           disc=${Buffer.from(disc).toString("hex")} spendable_sol_in=${spendableArg} min_tokens_out=${minTokensArg} trackVolume=${data[24]}`
  );
  assert(data.length === 25, `buy data is ${data.length} bytes, expected 25`);
  assert(
    disc.join(",") === PUMP_BUY_EXACT_SOL_IN_DISCRIMINATOR.join(","),
    `not buy_exact_sol_in (disc=${Buffer.from(disc).toString("hex")})`
  );
  assert(
    disc.join(",") !== PUMP_BUY_DISCRIMINATOR.join(","),
    "still the plain buy: the band would not be expressible"
  );
  assert(
    spendableArg === budget,
    `spendable_sol_in ${spendableArg} != budget ${budget} (full spend broken)`
  );
  assert(
    minTokensArg === quote.minTokensOut,
    `min_tokens_out ${minTokensArg} != banded floor ${quote.minTokensOut}`
  );
  assert(minTokensArg > BigInt(0), "min_tokens_out is zero: no floor at all");

  // The account list MUST match the proven `buy` instruction byte for byte.
  const plain = buildPumpBuyIx({
    mint,
    buyer: buyer.publicKey,
    creator: curve.creator,
    feeRecipient: FEE_RECIPIENT,
    tokensOut: quote.tokensOut,
    maxSolCost: budget,
  })[1];
  assert(
    plain.keys.length === buyIx.keys.length,
    `account count differs: buy ${plain.keys.length}, exact-in ${buyIx.keys.length}`
  );
  plain.keys.forEach((k, i) => {
    const mine = buyIx.keys[i];
    assert(
      mine.pubkey.equals(k.pubkey) &&
        mine.isSigner === k.isSigner &&
        mine.isWritable === k.isWritable,
      `account ${i} differs from the proven buy layout`
    );
  });
  console.log(
    `accounts         ${buyIx.keys.length} metas, identical to the proven buy layout`
  );

  // Counterfactual: what the plain buy would have needed to carry the band.
  const plainQuote = quotePumpBuy({
    solInLamports: budget,
    virtualSolReserves: curve.virtualSolReserves,
    virtualTokenReserves: curve.virtualTokenReserves,
    slippageBps: CURVE_SLIPPAGE_BPS,
  });
  console.log(
    `old shape        the plain buy at ${CURVE_SLIPPAGE_BPS} bps would need max_sol_cost ${plainQuote.maxSolCost.toString()} > budget ${budget} (the band cannot be funded from the budget)`
  );
  assert(
    plainQuote.maxSolCost > budget,
    "the plain-buy ceiling fits inside the budget: exact-in would not be needed"
  );

  const tx = new Transaction({ feePayer: buyer.publicKey }).add(...ixs);
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  tx.sign(buyer);
  const size = tx.serialize().length;
  console.log(`tx size          ${size} bytes (legacy limit ${MAX_TX_BYTES})`);
  assert(size <= MAX_TX_BYTES, `tx is ${size} bytes, over the legacy limit`);

  console.log(
    `\nOK: the curve MAX buy is buy_exact_sol_in spending exactly the budget (${budget} lamports) with a ${Number(CURVE_SLIPPAGE_BPS) / 100}% floor of ${minTokensArg} raw tokens, same accounts as buy, and the tx fits the legacy limit.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
