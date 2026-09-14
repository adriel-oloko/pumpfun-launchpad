// Live DEVNET acceptance for the manual Deposit SOL engine
// (docs/DEPOSIT_WINDOW.md section 9, leg 1).
//
// Public data only: this script never prints, logs or writes a secret. The hub
// keypair is read from ~/.config/solana/devnet.json (or --hub / HUB_KEYPAIR_JSON)
// and stays in memory; the base58 secret it hands to depositSol is never logged.
//
// Run:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T scripts/deposit-devnet-check.ts --yes
//
// It refuses to run without --yes and refuses a non-devnet RPC. It generates
// its own recipients:
//   - 22 rows of 0.001 SOL  -> must fit TWO hub-signed chunks (21 + 1), the
//     measured MAX_TRANSFERS_PER_TX doing its job;
//   - 1 row of 0.0001 SOL to a FRESH address -> must be excluded at PLAN time
//     as a `defect` (below the live 0-byte rent floor) while the other rows
//     still send, and that address must still be null on-chain afterwards.
//
// Proves (spec section 9):
//   (a) two confirmed chunk txs carrying all 22 transfers;
//   (b) the sub-floor fresh row excluded, not sent, not created/reverted;
//   (c) hub balance delta == sum(amounts) + 5_000 * chunks.

import { readFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import bs58 from "bs58";
import { Connection, Keypair, PublicKey } from "@solana/web3.js";
import {
	depositSol,
	planDeposit,
	type DepositAmountRow,
} from "../lib/deposit";

const DEVNET_DEFAULT_RPC = "https://api.devnet.solana.com";
const FEE_PER_CHUNK = BigInt(5_000);

function fail(msg: string): never {
	console.error(`FAIL: ${msg}`);
	process.exit(1);
}

function check(cond: boolean, msg: string): asserts cond {
	if (!cond) throw new Error(msg);
}

function argValue(flag: string): string | null {
	const i = process.argv.indexOf(flag);
	if (i < 0) return null;
	return process.argv[i + 1] ?? null;
}

interface ParsedTransferInfo {
	lamports?: number;
	destination?: string;
	source?: string;
}
interface ParsedInstruction {
	program?: string;
	programId?: string;
	parsed?: { type?: string; info?: ParsedTransferInfo };
}
interface ParsedTxResult {
	slot: number;
	meta: { err: unknown; fee: number } | null;
	transaction: { message: { instructions: ParsedInstruction[] } };
}

/** Raw getTransaction with encoding jsonParsed. web3.js v1's typed
 *  getTransaction cannot deserialize a jsonParsed payload (its superstruct
 *  expects string accountKeys), so the JSON-RPC call is issued directly: the
 *  same method, the same encoding the spec asks for. */
async function rpcGetParsedTransaction(
	rpc: string,
	signature: string
): Promise<ParsedTxResult> {
	const res = await fetch(rpc, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			jsonrpc: "2.0",
			id: 1,
			method: "getTransaction",
			params: [
				signature,
				{
					commitment: "confirmed",
					encoding: "jsonParsed",
					maxSupportedTransactionVersion: 0,
				},
			],
		}),
	});
	const payload = (await res.json()) as {
		error?: { message: string };
		result?: ParsedTxResult | null;
	};
	if (payload.error) throw new Error(payload.error.message);
	if (!payload.result) {
		throw new Error(`getTransaction returned null for ${signature}`);
	}
	return payload.result;
}

/** Loads the hub keypair without ever printing it. */
function loadHub(): Keypair {
	const path =
		argValue("--hub") ??
		process.env.HUB_KEYPAIR_JSON ??
		join(homedir(), ".config", "solana", "devnet.json");
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	let bytes: number[];
	if (Array.isArray(parsed)) {
		bytes = parsed as number[];
	} else if (
		parsed &&
		typeof parsed === "object" &&
		Array.isArray((parsed as { secretKey?: unknown }).secretKey)
	) {
		bytes = (parsed as { secretKey: number[] }).secretKey;
	} else {
		throw new Error(
			"HUB KEYPAIR JSON IS NEITHER A BYTE ARRAY NOR { secretKey }"
		);
	}
	check(bytes.length === 64, "hub keypair must be a 64-byte secret");
	return Keypair.fromSecretKey(Uint8Array.from(bytes));
}

async function run(): Promise<void> {
	if (!process.argv.includes("--yes")) {
		console.error(
			"REFUSING TO RUN: this sends real devnet transactions. Re-run with --yes."
		);
		process.exit(1);
	}
	const rpc = argValue("--rpc") ?? process.env.DEVNET_RPC_URL ?? DEVNET_DEFAULT_RPC;
	if (!/devnet/i.test(rpc)) {
		fail(`NON-DEVNET RPC REFUSED: ${rpc}`);
	}
	const connection = new Connection(rpc, "confirmed");

	const hub = loadHub();
	const hubPk = hub.publicKey;
	console.log(
		JSON.stringify({
			step: "setup",
			rpc,
			hub: hubPk.toBase58(),
			commitment: "confirmed",
		})
	);

	// ---- generate recipients: 22 fundable rows + 1 sub-floor fresh row -----
	const fundable: Keypair[] = [];
	for (let i = 0; i < 22; i++) fundable.push(Keypair.generate());
	const subFloor = Keypair.generate();
	const rows: DepositAmountRow[] = fundable.map((kp) => ({
		address: kp.publicKey.toBase58(),
		amountLamports: BigInt(1_000_000), // 0.001 SOL
	}));
	rows.push({
		address: subFloor.publicKey.toBase58(),
		amountLamports: BigInt(100_000), // 0.0001 SOL
	});

	// ---- live reads --------------------------------------------------------
	const floor0 = BigInt(
		await connection.getMinimumBalanceForRentExemption(0, "confirmed")
	);
	const hubBefore = BigInt(await connection.getBalance(hubPk, "confirmed"));
	const allAddresses = rows.map((r) => r.address);
	const infosBefore = await connection.getMultipleAccountsInfo(
		allAddresses.map((a) => new PublicKey(a)),
		"confirmed"
	);
	const fresh = new Set<string>();
	allAddresses.forEach((a, i) => {
		if (!infosBefore[i]) fresh.add(a);
	});
	console.log(
		JSON.stringify({
			step: "live_reads",
			floor0Lamports: floor0.toString(),
			hubBeforeLamports: hubBefore.toString(),
			freshGenerated: allAddresses.filter((a) => fresh.has(a)).length,
		})
	);

	// ---- plan --------------------------------------------------------------
	const plan = planDeposit({
		rows,
		hubLamports: hubBefore,
		freshAddresses: fresh,
		floor0Lamports: floor0,
	});
	check(plan.defects.length === 1, `expected 1 defect, got ${plan.defects.length}`);
	check(
		plan.defects[0].address === subFloor.publicKey.toBase58(),
		"the defect must be the sub-floor fresh row"
	);
	check(plan.cut.length === 0, `expected no cut rows, got ${plan.cut.length}`);
	check(plan.chunks.length === 2, `expected 2 chunks, got ${plan.chunks.length}`);
	check(
		plan.chunks[0].rows.length === 21 && plan.chunks[1].rows.length === 1,
		"expected chunks of 21 + 1"
	);
	check(
		plan.funded.length === 22,
		`expected 22 funded rows, got ${plan.funded.length}`
	);
	console.log(
		JSON.stringify({
			step: "plan",
			chunks: plan.chunks.map((c) => c.rows.length),
			funded: plan.funded.length,
			totalLamports: plan.totalLamports.toString(),
			feeLamports: plan.feeLamports.toString(),
			defects: plan.defects.map((d) => ({
				address: d.address,
				amountLamports: d.amountLamports.toString(),
				neededLamports: d.neededLamports.toString(),
			})),
			cut: plan.cut.length,
		})
	);

	// ---- send --------------------------------------------------------------
	// The base58 secret never leaves this call expression.
	const outcomes = await depositSol({
		connection,
		hub: { address: hubPk.toBase58(), key: bs58.encode(hub.secretKey) },
		plan,
		label: "deposit-check",
	});
	console.log(
		JSON.stringify({
			step: "send",
			chunks: outcomes.map((o) => ({
				index: o.index,
				count: o.count,
				totalLamports: o.totalLamports.toString(),
				signature: o.signature,
			})),
		})
	);

	// ---- verify on-chain ---------------------------------------------------
	let decodedTransfers = 0;
	let decodedLamports = BigInt(0);
	for (const o of outcomes) {
		const tx = await rpcGetParsedTransaction(rpc, o.signature);
		check(
			tx.meta?.err === null,
			`tx ${o.signature} err ${JSON.stringify(tx.meta?.err)}`
		);
		const instructions = tx.transaction.message.instructions;
		let inTx = 0;
		let inTxLamports = BigInt(0);
		for (const ix of instructions) {
			if (ix.program === "system" && ix.parsed?.type === "transfer") {
				inTx += 1;
				inTxLamports += BigInt(ix.parsed.info?.lamports ?? 0);
			}
		}
		check(
			inTx === o.count,
			`tx ${o.signature} carried ${inTx} transfers, expected ${o.count}`
		);
		decodedTransfers += inTx;
		decodedLamports += inTxLamports;
		console.log(
			JSON.stringify({
				step: "decode",
				signature: o.signature,
				err: tx.meta?.err ?? null,
				transfers: inTx,
				lamports: inTxLamports.toString(),
				slot: tx.slot,
			})
		);
	}
	check(decodedTransfers === 22, `decoded ${decodedTransfers} transfers, expected 22`);
	check(
		decodedLamports === plan.totalLamports,
		`decoded ${decodedLamports} lamports, expected ${plan.totalLamports}`
	);

	const hubAfter = BigInt(await connection.getBalance(hubPk, "confirmed"));
	const delta = hubBefore - hubAfter;
	const fees = FEE_PER_CHUNK * BigInt(outcomes.length);
	const expectedDelta = plan.totalLamports + fees;
	check(
		delta === expectedDelta,
		`hub delta ${delta} != sum ${plan.totalLamports} + fees ${fees}`
	);
	console.log(
		JSON.stringify({
			step: "hub_delta",
			hubBeforeLamports: hubBefore.toString(),
			hubAfterLamports: hubAfter.toString(),
			deltaLamports: delta.toString(),
			expectedDeltaLamports: expectedDelta.toString(),
			feePerChunk: FEE_PER_CHUNK.toString(),
			chunks: outcomes.length,
			ok: delta === expectedDelta,
		})
	);

	// ---- the sub-floor fresh address stays null ---------------------------
	const afterInfos = await connection.getMultipleAccountsInfo(
		[...fundable.map((kp) => kp.publicKey), subFloor.publicKey],
		"confirmed"
	);
	const defectInfo = afterInfos[afterInfos.length - 1];
	check(defectInfo === null, "the sub-floor fresh address must still not exist");
	const recipientBalances = fundable.map((kp, i) => ({
		address: kp.publicKey.toBase58(),
		lamports: afterInfos[i]?.lamports ?? null,
	}));
	console.log(
		JSON.stringify({
			step: "after_balances",
			recipients: recipientBalances,
			defect: {
				address: subFloor.publicKey.toBase58(),
				account: defectInfo,
				lamports: null,
			},
		})
	);

	console.log(
		JSON.stringify({
			step: "RESULT",
			ok: true,
			chunks: outcomes.length,
			transfers: decodedTransfers,
			sumLamports: decodedLamports.toString(),
			hubDeltaLamports: delta.toString(),
			defectAddress: subFloor.publicKey.toBase58(),
			defectStillNull: true,
		})
	);
}

run().catch((e) => {
	fail(e instanceof Error ? e.message : String(e));
});
