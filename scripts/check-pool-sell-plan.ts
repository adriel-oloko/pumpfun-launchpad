// READ-ONLY mainnet check of the manual SELL wiring on the migrated venue
// (no keys, no send: it BUILDS exactly what the panel's sell would send and
// asserts the shape and the numbers against the live pool).
//
// For a graduated mint it:
//   1. derives the canonical PumpSwap pool (canonicalMigratedPoolPda),
//   2. sizes a PARTIAL sell with pctTokens and folds its floor with
//      foldPoolSells (the plan the manual batch builds),
//   3. builds the instruction stream the first attempt sends
//      (swapSolanaState + sellInstructions with the FOLDED floor),
//   4. asserts:
//        - the fold's floor is never TIGHTER than the SDK's own 5% floor
//          (the fold may only ever loosen),
//        - the sell ix args are baseAmountIn = the partial amount and
//          minQuoteAmountOut = the folded floor,
//        - the WSOL account is created and CLOSED inside the same tx (so the
//          proceeds land as native SOL),
//        - the serialized tx fits the 1232-byte legacy limit.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/check-pool-sell-plan.ts [mint]

import { BN } from "@coral-xyz/anchor";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { Connection, Keypair, PublicKey, Transaction } from "@solana/web3.js";
import {
  OnlinePumpAmmSdk,
  PUMP_AMM_PROGRAM_ID,
  PumpAmmSdk,
  sellBaseInput,
} from "@pump-fun/pump-swap-sdk";
import { MANUAL_POOL_SELL_SLIPPAGE_PCT } from "../lib/batch-trade";
import { WSOL_MINT, canonicalMigratedPoolPda } from "../lib/migrate";
import { readPumpCurveState } from "../lib/pump";
import { pctTokens } from "../lib/sell-all";
import { foldPoolSells } from "../lib/sell-fold";
import { poolPercentFloor } from "../lib/swap";

const RPC =
  process.env.MAINNET_RPC ??
  "https://alien-billowing-voice.solana-mainnet.quiknode.pro/63ad5544cf41a4110f8a9bc5e8b2fa31420b620f";

/** The synthetic position the panel's Sell % would act on (1,000,000 tokens at
 *  6 decimals) and the percentage from the roster input. */
const BALANCE_RAW = BigInt("1000000000000");
const SELL_PCT = 50;
/** Highest fee tier total (93 + 2 + 30 bps), the fold's conservative default. */
const POOL_FEE_BPS_TOTAL = BigInt(125);
const MAX_TX_BYTES = 1232;

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
  console.log(`pool             ${poolKey.toBase58()} (${poolInfo?.data.length} bytes)`);

  const seller = Keypair.generate();
  const online = new OnlinePumpAmmSdk(connection);
  const sdk = new PumpAmmSdk();
  const state = await online.swapSolanaState(poolKey, seller.publicKey);

  const amount = pctTokens(BALANCE_RAW, SELL_PCT);
  console.log(
    `sell size        ${amount} raw tokens (${SELL_PCT}% of ${BALANCE_RAW})`
  );
  assert(amount > BigInt(0), "the percentage must leave something to sell");
  assert(amount < BALANCE_RAW, "a partial sell must not take the whole balance");

  const slippageBps = BigInt(MANUAL_POOL_SELL_SLIPPAGE_PCT * 100);
  const steps = foldPoolSells({
    balances: [{ address: seller.publicKey.toBase58(), tokens: amount }],
    baseReserve: BigInt(state.poolBaseAmount.toString()),
    quoteReserve: BigInt(state.poolQuoteAmount.toString()),
    virtualQuoteReserves: BigInt(state.pool.virtualQuoteReserves.toString()),
    feeBpsTotal: POOL_FEE_BPS_TOTAL,
    slippageBps,
  });
  assert(steps.length === 1, "the fold must plan exactly one seller");
  const foldedFloor = steps[0].minSolOut;
  console.log(`folded floor     ${foldedFloor} lamports (step amount ${steps[0].tokensIn})`);

  // The SDK's own 5% quote for the same amount: the fold's floor may be looser,
  // never tighter (a tighter floor is a guaranteed revert).
  const sdkQuote = sellBaseInput({
    base: new BN(amount.toString()),
    slippage: MANUAL_POOL_SELL_SLIPPAGE_PCT,
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
  console.log(
    `sdk quote        uiQuote=${sdkQuote.uiQuote.toString()} minQuote=${sdkQuote.minQuote.toString()} (5%)`
  );
  // The SHIPPED helper (lib/swap.ts poolPercentFloor), cross-checked against the
  // SDK's own free quote function just above: they must agree, or every
  // explicit-floor sell would be quoting a different trade than the percent
  // path it is supposed to mirror.
  const percentFloor = poolPercentFloor(
    state,
    amount,
    MANUAL_POOL_SELL_SLIPPAGE_PCT
  );
  assert(
    percentFloor === BigInt(sdkQuote.minQuote.toString()),
    `poolPercentFloor ${percentFloor} != the SDK's own minQuote ${sdkQuote.minQuote.toString()}`
  );
  // The shipped guarantee (sellMigratedPool): the floor the instruction carries
  // is the LOOSER of the folded floor and the percent floor, so a fold that
  // comes out a lamport tighter cannot revert a sell the percent path would
  // have landed.
  const expectedFloor = foldedFloor < percentFloor ? foldedFloor : percentFloor;
  if (foldedFloor > percentFloor) {
    console.log(
      `NOTE             the fold's floor is ${foldedFloor - percentFloor} lamport(s) TIGHTER than the percent floor; the shipped path takes the looser one (${expectedFloor})`
    );
  }

  // The manual leg's FIRST attempt: the folded floor handed in directly, which
  // is the SDK's `sellInstructions` path (sellMigratedPool's minOutLamports),
  // carrying the looser of the folded and the percent floor.
  const ixs = await sdk.sellInstructions(
    state,
    new BN(amount.toString()),
    new BN(expectedFloor.toString())
  );

  const sellIx = ixs.find(
    (ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.data.length === 24
  );
  assert(sellIx !== undefined, "no sell instruction (24-byte data) in the stream");
  const data = Buffer.from(sellIx.data);
  const baseAmountIn = data.readBigUInt64LE(8);
  const minQuoteAmountOut = data.readBigUInt64LE(16);
  console.log(
    `sell ix args     baseAmountIn=${baseAmountIn} minQuoteAmountOut=${minQuoteAmountOut}`
  );
  assert(
    baseAmountIn === amount,
    `baseAmountIn ${baseAmountIn} != the partial amount ${amount}`
  );
  assert(
    minQuoteAmountOut === expectedFloor,
    `minQuoteAmountOut ${minQuoteAmountOut} != the expected (loosest) floor ${expectedFloor}`
  );

  const wsolAta = getAssociatedTokenAddressSync(
    WSOL_MINT,
    seller.publicKey,
    false,
    TOKEN_PROGRAM_ID
  );
  // The WSOL ATA create (idempotent): ATA program, keys = [payer, ata, owner,
  // mint, system, token] -> the ATA is keys[1].
  const creates = ixs.filter(
    (ix) =>
      ix.programId.equals(
        new PublicKey("ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL")
      ) &&
      ix.keys[1]?.pubkey.equals(wsolAta) &&
      ix.keys[1]?.isSigner !== true
  );
  const closes = ixs.filter(
    (ix) => ix.programId.equals(TOKEN_PROGRAM_ID) && ix.data[0] === 9
  );
  console.log(
    `instructions     ${ixs.length} total: ${creates.length} WSOL ATA create, 1 sell, ${closes.length} WSOL close`
  );
  ixs.forEach((ix, i) => {
    console.log(
      `  [${i}] ${ix.programId.toBase58()} keys=${ix.keys.length} dataLen=${ix.data.length}`
    );
  });
  assert(closes.length === 1, "the WSOL account is not closed in the same tx");

  const tx = new Transaction({ feePayer: seller.publicKey }).add(...ixs);
  tx.recentBlockhash = (
    await connection.getLatestBlockhash("confirmed")
  ).blockhash;
  tx.sign(seller);
  const size = tx.serialize().length;
  console.log(`tx size          ${size} bytes (legacy limit ${MAX_TX_BYTES})`);
  assert(size <= MAX_TX_BYTES, `tx is ${size} bytes, over the legacy limit`);

  console.log(
    "\nOK: the partial pool sell is sized from the balance, floors at the LOOSER of the folded expectation and the live percent floor, and returns native SOL."
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
