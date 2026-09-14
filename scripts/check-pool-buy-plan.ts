// READ-ONLY mainnet check of the manual BUY MAX wiring on the migrated venue
// (no keys, no send: it BUILDS exactly what the panel's buy would send, through
// the SHIPPED builder lib/swap.ts `buildMigratedBuyIxs`, and asserts the shape
// and the numbers against the live pool).
//
// For a graduated mint it:
//   1. derives the canonical PumpSwap pool (canonicalMigratedPoolPda),
//   2. sizes a wallet's MAX budget with poolBuyBudgetLamports,
//   3. builds the instruction stream the buy goes through
//      (swapSolanaState + buildMigratedBuyIxs at POOL_BUY_SLIPPAGE_PCT),
//   4. asserts what the budget rule and the band depend on:
//        - the AMM instruction IS buy_exact_quote_in (discriminator + args), so
//          the spend is EXACT and the wallet cannot be overdrawn below its
//          0.002 SOL keep,
//        - spendable_quote_in IS the budget (full spend, nothing left behind),
//        - min_base_amount_out IS the banded floor (base at the live reserves,
//          less POOL_BUY_SLIPPAGE_PCT), which is what makes an adverse tick land
//          instead of reverting with pump_amm 6040,
//        - the SOL wrap (system transfer into the WSOL ATA) IS the budget: the
//          wallet holds exactly what the exact-in instruction takes,
//        - the WSOL account is created and CLOSED inside the same tx (so its
//          rent comes back),
//        - the serialized tx fits the 1232-byte legacy limit.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/check-pool-buy-plan.ts [mint]

import { Buffer } from "buffer";
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
} from "@pump-fun/pump-swap-sdk";
import { poolBuyBudgetLamports } from "../lib/batch-trade";
import { WSOL_MINT, canonicalMigratedPoolPda } from "../lib/migrate";
import { readPumpCurveState } from "../lib/pump";
import {
  POOL_BUY_SLIPPAGE_PCT,
  buildMigratedBuyIxs,
  poolBuyBaseOut,
  poolBuyMinBaseOut,
} from "../lib/swap";

const RPC =
  process.env.MAINNET_RPC ??
  "https://alien-billowing-voice.solana-mainnet.quiknode.pro/63ad5544cf41a4110f8a9bc5e8b2fa31420b620f";

/** The live balance the synthetic wallet is sized against (0.1 SOL). */
const LIVE_LAMPORTS = BigInt(100_000_000);
const MAX_TX_BYTES = 1232;
/** Token-2022 ATA size / WSOL (legacy) ATA size. */
const BASE_ATA_BYTES = 170;
const WSOL_ATA_BYTES = 165;
/** The program's exact-in discriminator (pump_amm IDL). */
const EXACT_IN_DISC = Buffer.from([198, 46, 21, 82, 180, 217, 232, 112]);
/** The SDK's plain-buy discriminator, i.e. what we must NOT be sending. */
const BUY_DISC = Buffer.from([102, 6, 61, 18, 1, 218, 235, 234]);

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
  console.log(`pool base        ${state.poolBaseAmount.toString()} raw tokens`);
  console.log(
    `pool quote       ${state.poolQuoteAmount.toString()} lamports (+virtual ${state.pool.virtualQuoteReserves.toString()})`
  );

  // The SHIPPED stream: what the panel's BUY MAX sends, byte for byte.
  const { ixs, baseOut, minBaseAmountOut } = await buildMigratedBuyIxs({
    sdk,
    state,
    spendableQuoteIn: budget,
    slippagePct: POOL_BUY_SLIPPAGE_PCT,
  });
  console.log(
    `band             ${POOL_BUY_SLIPPAGE_PCT}% -> base out ${baseOut.toString()} raw tokens, floor ${minBaseAmountOut.toString()}`
  );

  // 1. The AMM instruction must be buy_exact_quote_in, NOT the SDK's buy.
  const ammIx = ixs.find(
    (ix) => ix.programId.equals(PUMP_AMM_PROGRAM_ID) && ix.data.length === 25
  );
  assert(ammIx !== undefined, "no 25-byte pump_amm instruction in the stream");
  const data = Buffer.from(ammIx.data);
  const disc = data.subarray(0, 8);
  const spendableArg = data.readBigUInt64LE(8);
  const minBaseArg = data.readBigUInt64LE(16);
  console.log(
    `buy ix           disc=${disc.toString("hex")} spendableQuoteIn=${spendableArg} minBaseAmountOut=${minBaseArg} trackVolume=${data[24]}`
  );
  assert(
    disc.equals(EXACT_IN_DISC),
    `instruction is not buy_exact_quote_in (disc=${disc.toString("hex")})`
  );
  assert(
    !disc.equals(BUY_DISC),
    "instruction is still the SDK's plain buy: a band would not be expressible"
  );
  assert(
    spendableArg === budget,
    `spendableQuoteIn ${spendableArg} != budget ${budget} (full spend broken)`
  );

  // 2. The floor must be the banded base at the live reserves.
  const expectedBase = poolBuyBaseOut(state, budget);
  const expectedFloor = poolBuyMinBaseOut(expectedBase, POOL_BUY_SLIPPAGE_PCT);
  console.log(
    `expected floor   base ${expectedBase.toString()} * 80% = ${expectedFloor.toString()}`
  );
  assert(
    baseOut === expectedBase,
    `quoted base ${baseOut} != live quote ${expectedBase}`
  );
  assert(
    minBaseArg === expectedFloor,
    `minBaseAmountOut ${minBaseArg} != banded floor ${expectedFloor}`
  );
  assert(minBaseArg > BigInt(0), "minBaseAmountOut is zero: no floor at all");

  // 3. The WSOL wrap must be the budget itself (the exact-in spend).
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
  assert(
    wrapLamports === budget,
    `wrap ${wrapLamports} != budget ${budget} (the wallet would need more SOL than it has)`
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
    wrapLamports + BigInt(2_000_000) + BigInt(5_000) + BigInt(baseAtaRent) + BigInt(wsolAtaRent) ===
      LIVE_LAMPORTS,
    "budget + keep + fee + rents does not account for the whole live balance"
  );

  // 4. What the OLD shape would have needed: the SDK's plain buy wraps
  // budget * (1 + s/100), which a wallet sized to its keep does not hold. This
  // is the reason the exact-in instruction is used.
  const oldWrap =
    (budget * BigInt(Math.floor((1 + POOL_BUY_SLIPPAGE_PCT / 100) * 1e9))) /
    BigInt(1_000_000_000);
  console.log(
    `old shape        the SDK's plain buy at ${POOL_BUY_SLIPPAGE_PCT}% would wrap ${oldWrap} lamports > budget ${budget}`
  );
  assert(
    oldWrap > budget,
    "the plain-buy wrap fits inside the budget: the exact-in path would not be needed"
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
    `\nOK: the pool buy is buy_exact_quote_in spending exactly the MAX budget (${budget} lamports) with a ${POOL_BUY_SLIPPAGE_PCT}% floor of ${minBaseArg} raw tokens, the WSOL wrap/close nets out, and the tx fits the legacy limit.`
  );
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
