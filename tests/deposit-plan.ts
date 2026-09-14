// Offline regression tests for the manual Deposit SOL planner
// (docs/DEPOSIT_WINDOW.md). No network, no keys, no Connection: this suite
// pins the pure plan math (planDeposit), the pure text helpers
// (parseAmountList / cascadeAmountText), and the MEASURED 1232-byte legacy
// packet limit that fixes MAX_TRANSFERS_PER_TX = 21.
//
// The on-chain rule the planner encodes (section 4.2): a SystemProgram
// transfer to a NON-EXISTENT account creates it, and the runtime rejects the
// creation below the rent-exempt floor for a 0-byte account as a PREFLIGHT
// simulation failure. A tx is atomic, so one such row would fail its whole
// chunk; the planner therefore excludes those rows as `defects` at PLAN time.
// A LARGE floor is used in the fixtures on purpose so the excluded/included
// boundary is obvious; the engine reads the LIVE floor from the RPC.
//
// Run:
//   ./node_modules/.bin/ts-mocha -p ./tsconfig.test.json "tests/deposit-plan.ts"

import { expect } from "chai";
import {
	Keypair,
	SystemProgram,
	Transaction,
} from "@solana/web3.js";
import {
	DEPOSIT_TX_FEE_LAMPORTS,
	MAX_DEPOSIT_TX_BYTES,
	MAX_TRANSFERS_PER_TX,
	cascadeAmountText,
	parseAmountList,
	planDeposit,
	type DepositAmountRow,
	type DepositPlanInput,
} from "../lib/deposit";

const ZERO = BigInt(0);
const FEE = BigInt(5_000);
/** Fixture rent floor (lamports). The LIVE read is what the engine uses. */
const FLOOR0 = BigInt(650_240);
const NO_FRESH: ReadonlySet<string> = new Set<string>();

/** A dummy 32-byte blockhash so the size assert serializes a full legacy
 *  message exactly like the engine's send path does (web3.js sets the real
 *  one in sendAndConfirmWithRetry). */
const DUMMY_BLOCKHASH = "11111111111111111111111111111111";

function row(address: string, amountLamports: bigint): DepositAmountRow {
	return { address, amountLamports };
}

/** n identical fixture recipients, roster order. */
function rows(n: number, amountLamports: bigint): DepositAmountRow[] {
	const out: DepositAmountRow[] = [];
	for (let i = 0; i < n; i++) {
		out.push(row(`addr-${i}`, amountLamports));
	}
	return out;
}

/** The same chunk construction depositSol uses, sized for n transfers. */
function chunkBytes(n: number): number {
	const feePayer = Keypair.generate();
	const tx = new Transaction({ feePayer: feePayer.publicKey });
	tx.recentBlockhash = DUMMY_BLOCKHASH;
	for (let i = 0; i < n; i++) {
		tx.add(
			SystemProgram.transfer({
				fromPubkey: feePayer.publicKey,
				toPubkey: Keypair.generate().publicKey,
				lamports: 1_000_000,
			})
		);
	}
	return tx.serialize({
		requireAllSignatures: false,
		verifySignatures: false,
	}).length;
}

function plan(input: DepositPlanInput) {
	return planDeposit(input);
}

describe("planDeposit (docs/DEPOSIT_WINDOW.md section 6.2)", () => {
	it("1. empty rows: no chunks, zero totals, no cut, no defect", () => {
		const p = plan({
			rows: [],
			hubLamports: BigInt(10_000_000),
			freshAddresses: NO_FRESH,
			floor0Lamports: FLOOR0,
		});
		expect(p.chunks.length).to.equal(0);
		expect(p.totalLamports).to.equal(ZERO);
		expect(p.feeLamports).to.equal(ZERO);
		expect(p.cut.length).to.equal(0);
		expect(p.defects.length).to.equal(0);
		expect(p.shortfallLamports).to.equal(ZERO);
	});

	it("2. one row, hub generously funded: one chunk, one flat fee", () => {
		const p = plan({
			rows: rows(1, BigInt(1_000_000)),
			hubLamports: BigInt(1_005_000),
			freshAddresses: NO_FRESH,
			floor0Lamports: FLOOR0,
		});
		expect(p.chunks.length).to.equal(1);
		expect(p.funded.length).to.equal(1);
		expect(p.feeLamports).to.equal(FEE);
		expect(p.totalLamports).to.equal(BigInt(1_000_000));
	});

	it("3. 21 rows, hub = sum + one fee exactly: one chunk of 21, no cut", () => {
		const p = plan({
			rows: rows(21, BigInt(1_000_000)),
			hubLamports: BigInt(21_005_000),
			freshAddresses: NO_FRESH,
			floor0Lamports: FLOOR0,
		});
		expect(p.chunks.length).to.equal(1);
		expect(p.chunks[0].rows.length).to.equal(21);
		expect(p.cut.length).to.equal(0);
		expect(p.feeLamports).to.equal(FEE);
		expect(p.totalLamports).to.equal(BigInt(21_000_000));
	});

	it("4. 22 rows, hub = sum + two fees: chunks of 21 + 1", () => {
		const p = plan({
			rows: rows(22, BigInt(1_000_000)),
			hubLamports: BigInt(22_010_000),
			freshAddresses: NO_FRESH,
			floor0Lamports: FLOOR0,
		});
		expect(p.chunks.length).to.equal(2);
		expect(p.chunks[0].rows.length).to.equal(21);
		expect(p.chunks[1].rows.length).to.equal(1);
		expect(p.feeLamports).to.equal(BigInt(10_000));
		expect(p.cut.length).to.equal(0);
	});

	it("5. 22 rows, hub only covers the first chunk: row 22 is cut", () => {
		const p = plan({
			rows: rows(22, BigInt(1_000_000)),
			hubLamports: BigInt(21_005_000),
			freshAddresses: NO_FRESH,
			floor0Lamports: FLOOR0,
		});
		expect(p.chunks.length).to.equal(1);
		expect(p.chunks[0].rows.length).to.equal(21);
		expect(p.cut.length).to.equal(1);
		expect(p.cut[0].address).to.equal("addr-21");
		// needed at the cut row = its amount + the new chunk's flat fee.
		expect(p.shortfallLamports).to.equal(BigInt(1_000_000) + FEE);
	});

	it("6. 4 rows, hub covers rows 1-3: row 4 is cut, rows 1-3 are unchanged", () => {
		const input = rows(4, BigInt(1_000_000));
		const p = plan({
			rows: input,
			hubLamports: BigInt(3_005_000),
			freshAddresses: NO_FRESH,
			floor0Lamports: FLOOR0,
		});
		expect(p.funded.map((r) => r.address)).to.deep.equal([
			"addr-0",
			"addr-1",
			"addr-2",
		]);
		expect(p.funded.map((r) => r.amountLamports)).to.deep.equal([
			BigInt(1_000_000),
			BigInt(1_000_000),
			BigInt(1_000_000),
		]);
		expect(p.cut.map((r) => r.address)).to.deep.equal(["addr-3"]);
	});

	it("7. fresh address below the floor is a defect, not a cut", () => {
		const p = plan({
			rows: [row("fresh", FLOOR0 - BigInt(1))],
			hubLamports: BigInt(10_000_000),
			freshAddresses: new Set(["fresh"]),
			floor0Lamports: FLOOR0,
		});
		expect(p.defects.length).to.equal(1);
		expect(p.defects[0].address).to.equal("fresh");
		expect(p.defects[0].neededLamports).to.equal(FLOOR0);
		expect(p.cut.length).to.equal(0);
		expect(p.chunks.length).to.equal(0);
		expect(p.totalLamports).to.equal(ZERO);
		expect(p.feeLamports).to.equal(ZERO);
	});

	it("8. fresh address at exactly the floor is funded", () => {
		const p = plan({
			rows: [row("fresh", FLOOR0)],
			hubLamports: FLOOR0 + FEE,
			freshAddresses: new Set(["fresh"]),
			floor0Lamports: FLOOR0,
		});
		expect(p.defects.length).to.equal(0);
		expect(p.funded.length).to.equal(1);
		expect(p.totalLamports).to.equal(FLOOR0);
	});

	it("9. existing address below the floor (1 lamport) is funded", () => {
		const p = plan({
			rows: [row("existing", BigInt(1))],
			hubLamports: FEE + BigInt(1),
			freshAddresses: new Set(["fresh-only"]),
			floor0Lamports: FLOOR0,
		});
		expect(p.defects.length).to.equal(0);
		expect(p.funded.length).to.equal(1);
		expect(p.funded[0].amountLamports).to.equal(BigInt(1));
	});

	it("10. a sub-floor defect is skipped; the walk continues over the rest", () => {
		const input: DepositAmountRow[] = [
			row("a", BigInt(1_000_000)),
			row("b-fresh", BigInt(100_000)),
			row("c", BigInt(1_000_000)),
			row("d", BigInt(1_000_000)),
		];
		const p = plan({
			rows: input,
			hubLamports: BigInt(2_005_000),
			freshAddresses: new Set(["b-fresh"]),
			floor0Lamports: FLOOR0,
		});
		expect(p.defects.map((d) => d.address)).to.deep.equal(["b-fresh"]);
		// The plan is a contiguous prefix of [a, c, d]: the defect consumed no
		// hub balance and did not stop the walk, and `d` is the cut row.
		expect(p.funded.map((r) => r.address)).to.deep.equal(["a", "c"]);
		expect(p.cut.map((r) => r.address)).to.deep.equal(["d"]);
	});

	it("11. determinism: the same input yields a deep-equal plan", () => {
		const input: DepositPlanInput = {
			rows: rows(22, BigInt(1_000_000)),
			hubLamports: BigInt(21_500_000),
			freshAddresses: new Set(["addr-5"]),
			floor0Lamports: FLOOR0,
		};
		expect(plan(input)).to.deep.equal(plan(input));
	});
});

describe("parseAmountList / cascadeAmountText (section 6.2)", () => {
	it("12. splits on newlines, commas and whitespace and drops empties", () => {
		expect(parseAmountList("0.1\n0.2, 0.3 0.4\n\n")).to.deep.equal([
			"0.1",
			"0.2",
			"0.3",
			"0.4",
		]);
	});

	it("13. cascades from the given row, leaving earlier rows untouched", () => {
		const res = cascadeAmountText(["r0", "r1", "r2", "r3"], 1, "a\nb\nc");
		expect(res.rows).to.deep.equal(["r0", "a", "b", "c"]);
		expect(res.droppedCount).to.equal(0);
	});

	it("14. values past the last row are counted as dropped", () => {
		const res = cascadeAmountText(["r0", "r1", "r2", "r3"], 3, "a\nb\nc");
		expect(res.rows).to.deep.equal(["r0", "r1", "r2", "a"]);
		expect(res.droppedCount).to.equal(2);
	});
});

describe("legacy packet limit (section 4.1 / 6.2 case 15)", () => {
	it("MAX_TRANSFERS_PER_TX is the measured cap", () => {
		expect(MAX_TRANSFERS_PER_TX).to.equal(21);
		expect(MAX_DEPOSIT_TX_BYTES).to.equal(1232);
		expect(DEPOSIT_TX_FEE_LAMPORTS).to.equal(FEE);
	});

	it("21 transfers fit in one legacy packet", () => {
		const bytes = chunkBytes(21);
		expect(bytes).to.be.at.most(MAX_DEPOSIT_TX_BYTES);
	});

	it("22 transfers exceed the packet limit and throw at serialize", () => {
		expect(() => chunkBytes(22)).to.throw();
	});
});
