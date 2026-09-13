// READ-ONLY mainnet check of the manual BUY MAX wiring on the migrated venue
// (no keys, no send: it BUILDS exactly what the panel's buy would send and
// asserts the shape and the numbers against the live pool).
//
// For a graduated mint it:
//   1. derives the canonical PumpSwap pool (canonicalMigratedPoolPda),
//   2. sizes a wallet's MAX budget with poolBuyBudgetLamports,
//   3. builds the instruction stream the buy goes through
//      (swapSolanaState + buyQuoteInput at slippage 0),
//   4. asserts what the budget rule depends on:
//        - the SOL wrap (system transfer into the WSOL ATA) IS the budget,
//        - maxQuoteAmountIn IS the budget (so the wallet cannot be overdrawn
//          below its 0.002 SOL keep),
//        - baseAmountOut matches the SDK's own quote and is non-zero,
//        - the WSOL account is created and CLOSED inside the same tx (so its
//          rent comes back),
//        - the serialized tx fits the 1232-byte legacy limit.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/check-pool-buy-plan.ts [mint]

import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PumpAmmSdk,
  buyQuoteInput,
} from "@pump-fun/pump-swap-sdk";
import { poolBuyBudgetLamports } from "../lib/batch-trade";
import { WSOL_MINT, canonicalMigratedPoolPda } from "../lib/migrate";
import { readPumpCurveState } from "../lib/pump";

const RPC =
  process.env.MAINNET_RPC ??
  "https://alien-billowing-voice.solana-mainnet.quiknode.pro/63ad5544cf41a4110f8a9bc5e8b2fa31420b620f";

/** The live balance the synthetic wallet is sized against (0.1 SOL). */
const LIVE_LAMPORTS = BigInt(100_000_000);
const MAX_TX_BYTES = 1232;
/** Token-2022 ATA size / WSOL (legacy) ATA size. */
const BASE_ATA_BYTES = 170;
const WSOL_ATA_BYTES = 165;

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAILED: ${msg}`);
}

async function main(): Promise<void> {
  const mint = new PublicKey(
    process.argv[2] ?? "5LPRbTRqc37wWt6kGeyLgitnxrTFQBLfyK4D8aVMpump"
  );
  const connection = new Connection(RPC, "confirmed");

  const curve = await readPumpCurveState(connection, mint);
  assert(curve.kind === "ok", "curve account missing for this mint");
  assert(
    curve.kind === "ok" && curve.curve.complete,
    `curve not graduated (complete=${curve.kind === "ok" ? curve.curve.complete : "?"})`
  );
  console.log(`mint             ${mint.toBase58()} (curve complete = 1)`);

  const [poolKey] = canonicalMigratedPoolPda(mint);
  const poolInfo = await connection.getAccountInfo(poolKey, "confirmed");
  assert(poolInfo !== null, `pool ${poolKey.toBase58()} not found`);
  console.log(
    `pool             ${poolKey.toBase58()} (${poolInfo?.data.length} bytes, owner ${poolInfo?.owner.toBase58()})`
  );

  const [baseAtaRent, wsolAtaRent] = await Promise.all([
    connection.getMinimumBalanceForRentExemption(BASE_ATA_BYTES, "confirmed"),
    connection.getMinimumBalanceForRentExemption(WSOL_ATA_BYTES, "confirmed"),
  ]);
  const budget = poolBuyBudgetLamports({
    liveLamports: LIVE_LAMPORTS,
    baseAtaRentLamports: BigInt(baseAtaRent),
    wsolAtaRentLamports: BigInt(wsolAtaRent),
  });
  console.log(
    `rents            base-ATA(T22/${BASE_ATA_BYTES}b)=${baseAtaRent} WSOL-ATA(${WSOL_ATA_BYTES}b)=${wsolAtaRent}`
  );
  console.log(
    `budget           ${budget} lamports of ${LIVE_LAMPORTS} live (keep 2000000 + fee 5000 + rents)`
  );
  assert(budget > BigInt(0), "budget must be positive for a 0.1 SOL wallet");

  const buyer = Keypair.generate();
  const online = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const state = await online.swapSolanaState(poolKey, buyer.publicKey);
  const ixs = await sdk.buyQuoteInput(state, new BN(budget.toString()), 0);

  // The SDK's own quote for the same input/slippage: the ground truth the
  // instruction args must match.
  const quote = buyQuoteInput({
    quote: new BN(budget.toString()),
    slippage: 0,
    baseReserve: state.poolBaseAmount,
    quoteReserve: state.poolQuoteAmount,
    virtualQuoteReserves: state.pool.virtualQuoteReserves,
    globalConfig: state.globalConfig,
    baseMintAccount: state.baseMintAccount,
    baseMint: state.pool.baseMint,
    coinCreator: state.pool.coinCreator,
    creator: state.pool.creator,
    feeConfig: state.feeConfig,
  });
  console.log(`pool base        ${state.poolBaseAmount.toString()} raw tokens`);
  console.log(
    `pool quote       ${state.poolQuoteAmount.toString()} lamports (+virtual ${state.pool.virtualQuoteReserves.toString()})`
  );
  console.log(`quote.base       ${quote.base.toString()} raw tokens out`);
  console.log(`quote.maxQuote   ${quote.maxQuote.toString()} lamports in (cap)`);

  // The buy instruction: AMM anchor call, 8-byte discriminator +
  // (base_amount_out u64, max_quote_amount_in u64, track_volume bool).
  const buyIx = ixs.find(
    (ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.data.length === 25
  );
  assert(buyIx !== undefined, "no buy instruction (25-byte data) in the stream");
  const buyData = Buffer.from((buyIx as { data: Buffer }).data);
  const baseOutArg = buyData.readBigUInt64LE(8);
  const maxQuoteArg = buyData.readBigUInt64LE(16);
  console.log(
    `buy ix args      baseAmountOut=${baseOutArg} maxQuoteAmountIn=${maxQuoteArg} trackVolume=${buyData[24]}`
  );
  assert(
    baseOutArg === BigInt(quote.base.toString()),
    `baseAmountOut ${baseOutArg} != SDK quote ${quote.base.toString()}`
  );
  assert(
    maxQuoteArg === BigInt(quote.maxQuote.toString()),
    `maxQuoteAmountIn ${maxQuoteArg} != SDK quote ${quote.maxQuote.toString()}`
  );

  // The SOL wrap: a system transfer of the budget into the buyer's WSOL ATA.
  const wsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    buyer.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  const wrap = ixs.find(
    (ix) =>
      ix.programId.equals(SystemProgram.programId) &&
      ix.data.length === 12 &&
      ix.data.readUInt32LE(0) === 2
  );
  assert(wrap !== undefined, "no system transfer (WSOL wrap) in the stream");
  const wrapLamports = Buffer.from(wrap.data).readBigUInt64LE(4);
  const wrapTo = wrap.keys[1].pubkey;
  console.log(
    `wsol wrap        ${wrapLamports} lamports -> ${wrapTo.toBase58()}${wrapTo.equals(wsolAta) ? " (= WSOL ATA)" : ""}`
  );
  assert(
    wrapTo.equals(wsolAta),
    `wrap target ${wrapTo.toBase58()} != WSOL ATA ${wsolAta.toBase58()}`
  );

  const creates = ixs.filter((ix) =>
    ix.programId.equals(new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"))
  );
  const closes = ixs.filter(
    (ix) => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9
  );
  console.log(
    `instructions     ${ixs.length} total: ${creates.length} ATA create, 1 wrap, 1 buy, ${closes.length} WSOL close`
  );
  ixs.forEach((ix, i) => {
    console.log(
      `  [${i}] ${ix.programId.toBase58()} keys=${ix.keys.length} dataLen=${ix.data.length}`
    );
  });

  assert(closes.length === 1, "the WSOL account is not closed in the same tx");
  assert(
    wrapLamports === budget,
    `wrap ${wrapLamports} != budget ${budget} (the wallet would need more SOL than it has)`
  );
  assert(
    maxQuoteArg === budget,
    `maxQuoteAmountIn ${maxQuoteArg} != budget ${budget} (could overdraw below the keep)`
  );
  assert(baseOutArg > BigInt(0), "baseAmountOut is zero: nothing to buy");
  assert(
    wrapLamports + BigInt(2_000_000) + BigInt(5_000) + BigInt(baseAtaRent) + BigInt(wsolAtaRent) ===
      LIVE_LAMPORTS,
    "budget + keep + fee + rents does not account for the whole live balance"
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
    "\nOK: the pool buy wraps and commits exactly the MAX budget, buys a non-zero amount, and returns the WSOL rent."
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
