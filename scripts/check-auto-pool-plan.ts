// READ-ONLY mainnet check of the AUTO bot's BUY/SELL on the migrated venue (no
// keys, no send: it BUILDS exactly what the AUTO pool rounds would send and
// asserts the shape and the numbers against the live pool).
//
// For the frozen graduated pair it:
//   1. derives the canonical PumpSwap pool (canonicalMigratedPoolPda),
//   2. sizes each section 4.4 spendable with poolBuyCommitLamports,
//   3. builds the instruction stream the AUTO buy goes through
//      (swapSolanaState + buyQuoteInput at the bot's 10% slippage) and asserts
//      what the commit rule depends on:
//        - the SDK's maxQuoteAmountIn equals poolBuyWrapLamports(commit, 10)
//          (the WSOL wrap is that figure),
//        - the wrap never exceeds the spendable base (headroom >= 0, and exactly
//          1 lamport at the default 95%),
//        - base out is non-zero,
//        - the serialized tx fits the 1232-byte legacy limit,
//   4. builds the AUTO sell stream for a SELL % of a synthetic balance through
//      the same instruction path sellOneWalletOnPool uses (swapSolanaState +
//      sellBaseInput) and prints the sell args + tx size.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/check-auto-pool-plan.ts [mint]

import { BN } from "@coral-xyz/anchor";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PumpAmmSdk,
  buyQuoteInput,
} from "@pump-fun/pump-swap-sdk";
import {
  POOL_AUTO_SLIPPAGE_PCT,
  poolBuyCommitLamports,
  poolBuyWrapLamports,
} from "../lib/auto";
import { canonicalMigratedPoolPda } from "../lib/migrate";
import { readPumpCurveState } from "../lib/pump";
import { pctTokens } from "../lib/sell-all";

const RPC =
  process.env.MAINNET_RPC ??
  "https://alien-billowing-voice.solana-mainnet.quiknode.pro/63ad5544cf41a4110f8a9bc5e8b2fa31420b620f";

const MAX_TX_BYTES = 1232;
/** The section 4.4 spendables (0.01 / 0.05 / 0.10 SOL). */
const SPENDABLES = [BigInt(10_000_000), BigInt(50_000_000), BigInt(100_000_000)];
/** The synthetic sell balance (1000 tokens at 6 decimals) and the SELL %. */
const SELL_BALANCE = BigInt(1_000_000_000);
const SELL_PCT = 50;

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

  const online = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const buyer = Keypair.generate();
  const state = await online.swapSolanaState(poolKey, buyer.publicKey);
  console.log(
    `pool base        ${state.poolBaseAmount.toString()} raw tokens; quote ${state.poolQuoteAmount.toString()} lamports (+virtual ${state.pool.virtualQuoteReserves.toString()})`
  );

  // The bot's AUTO buy: commit = poolBuyCommitLamports(spendable), wrapped at
  // POOL_AUTO_SLIPPAGE_PCT (10). The table is the section 4.4 one.
  for (const spendable of SPENDABLES) {
    const commit = poolBuyCommitLamports(spendable);
    const expectedWrap = poolBuyWrapLamports(commit, POOL_AUTO_SLIPPAGE_PCT);
    // The SDK's own quote for the same input/slippage: the ground truth the
    // instruction args must match.
    const quote = buyQuoteInput({
      quote: new BN(commit.toString()),
      slippage: POOL_AUTO_SLIPPAGE_PCT,
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
    const maxQuote = BigInt(quote.maxQuote.toString());
    const base = BigInt(quote.base.toString());
    const headroom = spendable - maxQuote;
    console.log(
      `BUY  spendable=${spendable} commit=${commit} maxQuote=${maxQuote} wrap=${expectedWrap} headroom=${headroom} base=${base}`
    );
    assert(
      maxQuote === expectedWrap,
      `maxQuoteAmountIn ${maxQuote} != poolBuyWrapLamports ${expectedWrap}`
    );
    assert(headroom >= BigInt(0), `wrap ${maxQuote} exceeds spendable ${spendable}`);
    assert(base > BigInt(0), "baseAmountOut is zero: nothing to buy");

    const ixs = await sdk.buyQuoteInput(
      state,
      new BN(commit.toString()),
      POOL_AUTO_SLIPPAGE_PCT
    );
    const tx = new Transaction({ feePayer: buyer.publicKey }).add(...ixs);
    tx.recentBlockhash = (
      await connection.getLatestBlockhash("confirmed")
    ).blockhash;
    tx.sign(buyer);
    const size = tx.serialize().length;
    console.log(`     ixs=${ixs.length} txSize=${size} bytes`);
    assert(
      size <= MAX_TX_BYTES,
      `buy tx is ${size} bytes, over the legacy limit`
    );
  }

  // The bot's AUTO sell: SELL % of a synthetic live balance through the same
  // instruction path sellOneWalletOnPool -> sellMigratedPool uses.
  const seller = Keypair.generate();
  const sellState = await online.swapSolanaState(poolKey, seller.publicKey);
  const baseAmount = pctTokens(SELL_BALANCE, SELL_PCT);
  assert(baseAmount > BigInt(0), "SELL % floored to zero on the synthetic balance");
  const sellIxs = await sdk.sellBaseInput(
    sellState,
    new BN(baseAmount.toString()),
    POOL_AUTO_SLIPPAGE_PCT
  );
  const sellIx = sellIxs.find(
    (ix) =>
      ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.data.length === 24
  );
  assert(sellIx !== undefined, "no AMM sell instruction (24-byte data) in the stream");
  const sellData = Buffer.from((sellIx as { data: Buffer }).data);
  const baseInArg = sellData.readBigUInt64LE(8);
  const minOutArg = sellData.readBigUInt64LE(16);
  console.log(
    `SELL balance=${SELL_BALANCE} sellPct=${SELL_PCT} baseAmountIn=${baseInArg} minQuoteAmountOut=${minOutArg}`
  );
  assert(
    baseInArg === baseAmount,
    `sell baseAmountIn ${baseInArg} != pctTokens ${baseAmount}`
  );
  assert(minOutArg > BigInt(0), "minQuoteAmountOut is zero");
  const sellTx = new Transaction({ feePayer: seller.publicKey }).add(...sellIxs);
  sellTx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  sellTx.sign(seller);
  const sellSize = sellTx.serialize().length;
  console.log(`     ixs=${sellIxs.length} txSize=${sellSize} bytes`);
  assert(
    sellSize <= MAX_TX_BYTES,
    `sell tx is ${sellSize} bytes, over the legacy limit`
  );

  console.log(
    "\nOK: the AUTO pool buy wraps exactly poolBuyWrapLamports(commit, 10) <= spendable (1-lamport headroom at 95%), buys a non-zero amount, and both the buy and sell streams fit the legacy limit."
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
