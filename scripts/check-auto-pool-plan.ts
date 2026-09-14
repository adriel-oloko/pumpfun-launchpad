// READ-ONLY mainnet check of the AUTO bot's BUY/SELL on the migrated venue (no
// keys, no send: it BUILDS exactly what the AUTO pool rounds would send, through
// the SHIPPED builders, and asserts the shape and the numbers against the live
// pool).
//
// For the frozen graduated pair it:
//   1. derives the canonical PumpSwap pool (canonicalMigratedPoolPda),
//   2. sizes each section 4.4 spendable with poolBuyCommitLamports,
//   3. builds the instruction stream the AUTO buy goes through
//      (swapSolanaState + lib/swap.ts buildMigratedBuyIxs at
//      POOL_AUTO_SLIPPAGE_PCT) and asserts what the commit rule depends on:
//        - the AMM instruction IS buy_exact_quote_in (discriminator),
//        - spendable_quote_in IS the commit (full spend of the commit),
//        - the SOL wrap (system transfer into the WSOL ATA) IS the commit, so
//          commit <= spendable holds with no band on top of it (the old
//          `spendable / 1.10` cap is gone),
//        - min_base_amount_out IS the banded floor (base at the live reserves
//          less the band), i.e. the band is real,
//        - base out is non-zero,
//        - the serialized tx fits the 1232-byte legacy limit,
//   4. builds the AUTO sell stream for a SELL % of a synthetic balance through
//      the same instruction path sellOneWalletOnPool uses (swapSolanaState +
//      sellBaseInput) and prints the sell args + tx size.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/check-auto-pool-plan.ts [mint]

import { BN } from "@coral-xyz/anchor";
import { Buffer } from "buffer";
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PumpAmmSdk,
} from "@pump-fun/pump-swap-sdk";
import {
  POOL_AUTO_SLIPPAGE_PCT,
  poolBuyCommitLamports,
} from "../lib/auto";
import { canonicalMigratedPoolPda } from "../lib/migrate";
import { readPumpCurveState } from "../lib/pump";
import { pctTokens } from "../lib/sell-all";
import { buildMigratedBuyIxs, poolBuyBaseOut, poolBuyMinBaseOut } from "../lib/swap";

const RPC =
  process.env.MAINNET_RPC ??
  "https://alien-billowing-voice.solana-mainnet.quiknode.pro/63ad5544cf41a4110f8a9bc5e8b2fa31420b620f";

const MAX_TX_BYTES = 1232;
/** The section 4.4 spendables (0.01 / 0.05 / 0.10 SOL). */
const SPENDABLES = [BigInt(10_000_000), BigInt(50_000_000), BigInt(100_000_000)];
/** The synthetic sell balance (1000 tokens at 6 decimals) and the SELL %. */
const SELL_BALANCE = BigInt(1_000_000_000);
const SELL_PCT = 50;
/** The program's exact-in discriminator (pump_amm IDL). */
const EXACT_IN_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);

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

  // The bot's AUTO buy: commit = poolBuyCommitLamports(spendable), exact-in at
  // POOL_AUTO_SLIPPAGE_PCT. The table is the section 4.4 one.
  for (const spendable of SPENDABLES) {
    const commit = poolBuyCommitLamports(spendable);
    const { ixs, baseOut, minBaseAmountOut } = await buildMigratedBuyIxs({
      sdk,
      state,
      spendableQuoteIn: commit,
      slippagePct: POOL_AUTO_SLIPPAGE_PCT,
    });
    const ammIx = ixs.find(
      (ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.data.length === 25
    );
    assert(ammIx !== undefined, "no 25-byte pump_amm buy instruction in the stream");
    const data = Buffer.from(ammIx.data);
    const spendableArg = data.readBigUInt64LE(8);
    const minBaseArg = data.readBigUInt64LE(16);
    const headroom = spendable - commit;
    console.log(
      `BUY  spendable=${spendable} commit=${commit} spendableQuoteIn=${spendableArg} minBaseAmountOut=${minBaseArg} headroom=${headroom} base=${baseOut}`
    );
    assert(
      data.subarray(0, 8).equals(EXACT_IN_DISC),
      `buy is not buy_exact_quote_in (disc=${data.subarray(0, 8).toString("hex")})`
    );
    assert(
      spendableArg === commit,
      `spendableQuoteIn ${spendableArg} != commit ${commit}`
    );
    assert(
      minBaseArg ===
        poolBuyMinBaseOut(poolBuyBaseOut(state, commit), POOL_AUTO_SLIPPAGE_PCT),
      `minBaseAmountOut ${minBaseArg} is not the banded floor of the live quote`
    );
    assert(commit <= spendable, `commit ${commit} exceeds spendable ${spendable}`);
    assert(baseOut > BigInt(0), "base out is zero: nothing to buy");
    assert(minBaseAmountOut > BigInt(0), "minBaseAmountOut is zero: no floor");

    // The wrap is the commit itself (exact-in), so it can never need more SOL
    // than the spendable base.
    const wrapIx = ixs.find(
      (ix) =>
        ix.programId.equals(SystemProgram.programId) && ix.data.length === 12
    );
    assert(wrapIx !== undefined, "no system transfer (WSOL wrap) in the stream");
    const wrapLamports = Buffer.from(wrapIx.data).readBigUInt64LE(4);
    assert(
      wrapLamports === commit,
      `wrap ${wrapLamports} != commit ${commit}`
    );
    assert(
      wrapLamports <= spendable,
      `wrap ${wrapLamports} exceeds spendable ${spendable}`
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
    `SELL balance=${SELL_BALANCE} sellPct=${SELL_PCT} baseAmountIn=${baseInArg} minQuoteAmountOut=${minOutArg} (band ${POOL_AUTO_SLIPPAGE_PCT}%)`
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
    `\nOK: the AUTO pool buy is buy_exact_quote_in spending exactly the commit (= the WSOL wrap) with a ${POOL_AUTO_SLIPPAGE_PCT}% floor, and both the buy and sell streams fit the legacy limit.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
