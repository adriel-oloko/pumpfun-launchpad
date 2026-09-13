// Read-only proof for the Trade header's token-identity reads.
//
// For each mint on the command line, prints what the two on-chain readers
// return:
//   readToken2022Metadata  -> the in-mint Token-2022 metadata extension
//                             (create_v2 mints, the launchpad's own)
//   readMetadataStrings    -> the Metaplex metadata account for the mint
//                             (legacy SPL mints)
//
// Sends nothing; reads only. Usage:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T \
//     scripts/check-token-metadata.ts <mint> [mint...]
import { Connection, PublicKey } from "@solana/web3.js";
import { readMetadataStrings, readToken2022Metadata } from "../lib/bundle/launch";
import { pumpMetadataPda } from "../lib/pump";

const RPCS = [
	process.env.SOLANA_MAINNET_RPC,
	"https://api.mainnet-beta.solana.com",
].filter((u): u is string => Boolean(u));

async function connection(): Promise<Connection> {
	let lastErr: unknown = null;
	for (const url of RPCS) {
		const c = new Connection(url, "confirmed");
		try {
			await c.getSlot();
			console.log(`rpc: ${url}`);
			return c;
		} catch (e) {
			lastErr = e;
			console.log(`rpc unreachable, trying next: ${url}`);
		}
	}
	throw lastErr;
}

async function main() {
	const mints = process.argv.slice(2);
	if (mints.length === 0) {
		console.error("usage: check-token-metadata.ts <mint> [mint...]");
		process.exit(2);
	}
	const c = await connection();
	let failures = 0;
	for (const raw of mints) {
		const mint = new PublicKey(raw);
		const info = await c.getAccountInfo(mint, "confirmed");
		const owner = info?.owner.toBase58() ?? null;
		const inMint = await readToken2022Metadata(c, mint);
		const pda = pumpMetadataPda(mint)[0];
		const metaplex = await readMetadataStrings(c, pda);
		// The header renders the FIRST of these that exists.
		const shown = inMint ?? metaplex;
		console.log(`\nmint      : ${raw}`);
		console.log(`account   : ${info ? `${info.data.length} bytes, owner ${owner}` : "MISSING"}`);
		console.log(
			`in-mint   : ${inMint ? `${inMint.name} ($${inMint.symbol}) uri=${inMint.uri}` : "none"}`,
		);
		console.log(`metaplex  : ${pda.toBase58()}`);
		console.log(
			`            ${metaplex ? `${metaplex.name} ($${metaplex.symbol}) uri=${metaplex.uri}` : "none"}`,
		);
		console.log(
			`HEADER    : ${shown ? `${shown.name} ($${shown.symbol})` : `${raw.slice(0, 6)}...${raw.slice(-6)} (no metadata)`}`,
		);
		if (!shown) failures += 1;
	}
	console.log(`\n${mints.length - failures}/${mints.length} resolved to a name`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
