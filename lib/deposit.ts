// The manual Deposit SOL engine (docs/DEPOSIT_WINDOW.md).
//
// This is the exact-amount sibling of `disperseSol` (lib/disperse.ts): both
// fund roster wallets from the HUB (the FIRST roster wallet) with ONE
// signature per transaction and a flat base fee per transaction, and neither
// has an auto-refund (Solana moves exactly sum(amounts)). The difference is
// that here the operator types an exact amount per row instead of a random
// amount in [MIN, MAX].
//
// MAX_TRANSFERS_PER_TX = 21 is MEASURED, not chosen: a legacy
// Transaction (one hub signer) serializes 1195 bytes at 21 SystemProgram
// transfers and 1244 bytes at 22, against the 1232-byte packet limit
// (docs/DEPOSIT_WINDOW.md section 4.1).
//
// The sub-floor rule (docs/DEPOSIT_WINDOW.md section 4.2) is enforced by the
// PLAN, never by a runtime catch: a SystemProgram.transfer to a NON-EXISTENT
// account creates it, and the runtime rejects the creation when the amount is
// below the rent-exempt minimum for a 0-byte account. That failure is a
// PREFLIGHT simulation failure, and a transaction is atomic, so one such row
// would fail its whole chunk. planDeposit therefore EXCLUDES such rows as
// `defects` before anything is built or sent; no try/catch below turns a rent
// failure into success.
//
// All amounts are bigint (no bigint literals: the project target is ES2017).

import bs58 from "bs58";
import {
	Connection,
	Keypair,
	PublicKey,
	SystemProgram,
	Transaction,
} from "@solana/web3.js";
import { sendAndConfirmWithRetry } from "./bundle/launch";
import type { DisperseHub } from "./disperse";

/** 1232-byte legacy packet limit that bounds a chunk (measured, section 4.1). */
export const MAX_DEPOSIT_TX_BYTES = 1232;
/** Transfers per chunk: MEASURED maximum for one hub-signed legacy tx (section 4.1). */
export const MAX_TRANSFERS_PER_TX = 21;
/** Base fee of one single-signature legacy tx (lamports), paid once per chunk. */
export const DEPOSIT_TX_FEE_LAMPORTS: bigint = BigInt(5_000);

export interface DepositAmountRow {
	address: string;
	amountLamports: bigint;
}
export interface DepositDefect {
	address: string;
	amountLamports: bigint;
	neededLamports: bigint;
}
export interface DepositCut {
	address: string;
	amountLamports: bigint;
}
export interface DepositChunk {
	rows: DepositAmountRow[];
}

export interface DepositPlanInput {
	/** Roster order; the caller drops zero/blank rows before calling. */
	rows: readonly DepositAmountRow[];
	/** Live hub lamports (fee payer AND source). */
	hubLamports: bigint;
	/** Addresses whose account does not exist on-chain (see section 5). */
	freshAddresses: ReadonlySet<string>;
	/** Live getMinimumBalanceForRentExemption(0). */
	floor0Lamports: bigint;
	txFeeLamports?: bigint; // default DEPOSIT_TX_FEE_LAMPORTS
	maxTransfersPerTx?: number; // default MAX_TRANSFERS_PER_TX
}

export interface DepositPlan {
	chunks: DepositChunk[]; // each chunk = one hub-signed tx, in send order
	funded: DepositAmountRow[]; // flattened chunks, roster order
	cut: DepositCut[]; // rows from the first that did not fit onward, roster order
	defects: DepositDefect[]; // fresh accounts below the create floor (excluded, roster order)
	totalLamports: bigint; // sum(funded)
	feeLamports: bigint; // txFeeLamports * chunks.length
	hubLamports: bigint;
	shortfallLamports: bigint; // need - have at the first cut row, 0n when nothing was cut
}

/** Pure deposit planner (docs/DEPOSIT_WINDOW.md section 6.1).
 *
 *  1. Partition `defects`: a candidate whose account is fresh AND whose
 *     amount is below the live rent floor is excluded with no hub cost and
 *     does not stop the walk.
 *  2. Walk the rest in order. A candidate that starts a new chunk (every
 *     `maxTransfersPerTx` included rows) also carries the flat tx fee. The
 *     first row that does not fit — together with every later candidate —
 *     becomes `cut`; nothing is shrunk and nothing is skipped over.
 *  3. The invariant `totalLamports + feeLamports <= hubLamports` holds
 *     whenever at least one chunk exists; a violation is a bug, not a user
 *     facing path, so it throws a plain Error.
 */
export function planDeposit(input: DepositPlanInput): DepositPlan {
	const feeLamportsPerTx = input.txFeeLamports ?? DEPOSIT_TX_FEE_LAMPORTS;
	const cap =
		input.maxTransfersPerTx && input.maxTransfersPerTx > 0
			? input.maxTransfersPerTx
			: MAX_TRANSFERS_PER_TX;
	const hubLamports = input.hubLamports;

	const defects: DepositDefect[] = [];
	const walkable: DepositAmountRow[] = [];
	for (const row of input.rows) {
		if (
			input.freshAddresses.has(row.address) &&
			row.amountLamports < input.floor0Lamports
		) {
			defects.push({
				address: row.address,
				amountLamports: row.amountLamports,
				neededLamports: input.floor0Lamports,
			});
		} else {
			walkable.push(row);
		}
	}

	const included: DepositAmountRow[] = [];
	const cut: DepositCut[] = [];
	let spent = BigInt(0);
	let totalLamports = BigInt(0);
	let shortfallLamports = BigInt(0);
	for (let j = 0; j < walkable.length; j++) {
		const row = walkable[j];
		const startsChunk = j % cap === 0;
		const delta =
			row.amountLamports + (startsChunk ? feeLamportsPerTx : BigInt(0));
		if (spent + delta <= hubLamports) {
			included.push(row);
			spent += delta;
			totalLamports += row.amountLamports;
			continue;
		}
		// THIS row and every later candidate are cut: the walk stops, no
		// amount is shrunk, and nothing after the gap is silently skipped
		// into a later chunk.
		shortfallLamports = spent + delta - hubLamports;
		for (let k = j; k < walkable.length; k++) {
			cut.push({
				address: walkable[k].address,
				amountLamports: walkable[k].amountLamports,
			});
		}
		break;
	}

	const chunks: DepositChunk[] = [];
	for (let i = 0; i < included.length; i += cap) {
		chunks.push({ rows: included.slice(i, i + cap) });
	}
	const feeLamports = feeLamportsPerTx * BigInt(chunks.length);
	if (chunks.length > 0 && totalLamports + feeLamports > hubLamports) {
		throw new Error(
			`DEPOSIT PLANNER BUG: TOTAL ${totalLamports} + FEE ${feeLamports} EXCEEDS HUB ${hubLamports}`
		);
	}

	return {
		chunks,
		funded: included,
		cut,
		defects,
		totalLamports,
		feeLamports,
		hubLamports,
		shortfallLamports,
	};
}

export interface DepositChunkOutcome {
	index: number;
	count: number;
	totalLamports: bigint;
	signature: string;
}

/** A chunk send failure: carries the chunk index and every signature that
 *  already landed, so the caller can report the partial truth instead of
 *  claiming all-or-nothing. Never exported (the UI reads `.message`). */
class DepositChunkError extends Error {
	readonly chunkIndex: number;
	readonly signatures: string[];
	constructor(chunkIndex: number, signatures: string[], cause: unknown) {
		const detail = cause instanceof Error ? cause.message : String(cause);
		super(
			`DEPOSIT: CHUNK ${chunkIndex + 1} FAILED AFTER ${signatures.length} CONFIRMED CHUNK(S) (${signatures.length > 0 ? signatures.join(", ") : "NONE"}): ${detail}`
		);
		this.name = "DepositChunkError";
		this.chunkIndex = chunkIndex;
		this.signatures = signatures;
	}
}

/** Sends a planned deposit as ONE hub-signed legacy transaction per chunk,
 *  SEQUENTIALLY through the repo's only send path
 *  (sendAndConfirmWithRetry: expiry-safe re-send, never a blind
 *  double-fire). Sequential is required: two hub-signed txs in flight race
 *  the same balance and blockhash. On the first chunk failure the remaining
 *  chunks are NOT sent and the error carries the chunk index plus the
 *  signatures that already landed. */
export async function depositSol(opts: {
	connection: Connection;
	hub: DisperseHub;
	plan: DepositPlan;
	label?: string; // default "deposit"
}): Promise<DepositChunkOutcome[]> {
	const { connection, hub, plan } = opts;
	const label = opts.label ?? "deposit";
	let hubKp: Keypair;
	try {
		hubKp = Keypair.fromSecretKey(bs58.decode(hub.key));
	} catch {
		throw new Error(
			`DEPOSIT: HUB HAS NO VALID KEY (RE-ADD THE HUB SECRET IN THE ROSTER): ${hub.address}`
		);
	}
	const outcomes: DepositChunkOutcome[] = [];
	for (let i = 0; i < plan.chunks.length; i++) {
		const chunk = plan.chunks[i];
		const tx = new Transaction({ feePayer: hubKp.publicKey });
		let totalLamports = BigInt(0);
		for (const row of chunk.rows) {
			let to: PublicKey;
			try {
				to = new PublicKey(row.address);
			} catch {
				throw new Error(
					`DEPOSIT: INVALID RECIPIENT ADDRESS ${row.address}`
				);
			}
			tx.add(
				SystemProgram.transfer({
					fromPubkey: hubKp.publicKey,
					toPubkey: to,
					lamports: Number(row.amountLamports),
				})
			);
			totalLamports += row.amountLamports;
		}
		let signature: string;
		try {
			const res = await sendAndConfirmWithRetry(
				connection,
				tx,
				[hubKp],
				{
					attempts: 2,
					confirmTimeoutMs: 45_000,
					label,
				}
			);
			signature = res.signature;
		} catch (e) {
			throw new DepositChunkError(
				i,
				outcomes.map((o) => o.signature),
				e
			);
		}
		outcomes.push({
			index: i,
			count: chunk.rows.length,
			totalLamports,
			signature,
		});
	}
	return outcomes;
}

/** Split pasted/typed text into amount tokens: newlines, commas and whitespace. */
export function parseAmountList(text: string): string[] {
	return text
		.split(/[\s,]+/)
		.map((s) => s.trim())
		.filter((s) => s.length > 0);
}

/** Cascade `text` into rows starting at `fromIndex`; returns the next rows + how
 *  many values had no row to land in. Pure. */
export function cascadeAmountText(
	rows: readonly string[],
	fromIndex: number,
	text: string
): { rows: string[]; droppedCount: number } {
	const tokens = parseAmountList(text);
	const next = rows.slice();
	let droppedCount = 0;
	for (let i = 0; i < tokens.length; i++) {
		const idx = fromIndex + i;
		if (idx >= 0 && idx < next.length) {
			next[idx] = tokens[i];
		} else {
			droppedCount += 1;
		}
	}
	return { rows: next, droppedCount };
}
