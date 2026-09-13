// Read-only breakdown of the Trade header's in-mint metadata read.
//
// Prints, per mint: the account layout (82-byte Mint, padding to ACCOUNT_SIZE
// = 165, account-type byte, TLV extensions), what the OLD raw-data slice
// returned (always null: that was the header bug), and the SHIPPED reader's
// result cross-checked against @solana/spl-token-metadata's unpack.
//
// Sends nothing; reads only. Usage:
//   ./node_modules/.bin/ts-node -P ./tsconfig.test.json -T \
//     scripts/probe-token2022-metadata.ts <mint> [mint...]
import { Connection, PublicKey } from "@solana/web3.js";
import {
	ACCOUNT_SIZE,
	ACCOUNT_TYPE_SIZE,
	ExtensionType,
	TOKEN_2022_PROGRAM_ID,
	getExtensionData,
} from "@solana/spl-token";
import { unpack } from "@solana/spl-token-metadata";
import { readToken2022Metadata } from "../lib/bundle/launch";

const TLV_OFFSET = ACCOUNT_SIZE + ACCOUNT_TYPE_SIZE;

const RPCS = [
	process.env.SOLANA_MAINNET_RPC,
	"https://api.mainnet-beta.solana.com",
].filter((u): u is string => Boolean(u));

async function main() {
	const raw = process.argv.slice(2);
	if (raw.length === 0) {
		console.error("usage: probe-token2022-metadata.ts <mint> [mint...]");
		process.exit(2);
	}
	let c: Connection | null = null;
	for (const url of RPCS) {
		const tryConn = new Connection(url, "confirmed");
		try {
			await tryConn.getSlot();
			console.log(`rpc: ${url}`);
			c = tryConn;
			break;
		} catch {
			console.log(`rpc unreachable, trying next: ${url}`);
		}
	}
	if (!c) throw new Error("no reachable rpc");
	const connection = c;

	for (const addr of raw) {
		const mint = new PublicKey(addr);
		const info = await connection.getAccountInfo(mint, "confirmed");
		console.log(`\nmint    : ${addr}`);
		if (!info) {
			console.log("          MISSING on this cluster");
			continue;
		}
		console.log(
			`account : ${info.data.length} bytes, owner ${info.owner.toBase58()}`,
		);
		if (!info.owner.equals(TOKEN_2022_PROGRAM_ID)) {
			console.log("          legacy SPL mint: no extension area (Metaplex path)");
			continue;
		}
		console.log(
			`data[${ACCOUNT_SIZE}] (account type byte) = ${info.data[ACCOUNT_SIZE]} (1 = Mint)`,
		);
		const rawExt = getExtensionData(ExtensionType.TokenMetadata, info.data);
		console.log(
			`OLD getExtensionData(RAW data)     : ${rawExt ? `${rawExt.length} bytes` : "null  <-- the header bug"}`,
		);
		const tlvExt = getExtensionData(
			ExtensionType.TokenMetadata,
			info.data.subarray(TLV_OFFSET),
		);
		console.log(
			`getExtensionData(TLV @${TLV_OFFSET}) : ${tlvExt ? `${tlvExt.length} bytes` : "null"}`,
		);
		const shipped = await readToken2022Metadata(connection, mint);
		console.log(
			`SHIPPED reader                     : ${shipped ? `name="${shipped.name}" symbol="${shipped.symbol}" uri=${shipped.uri}` : "null"}`,
		);
		if (tlvExt) {
			const official = unpack(tlvExt);
			console.log(
				`cross-check (official unpack)      : name="${official.name}" symbol="${official.symbol}" uri=${official.uri}`,
			);
			const agree =
				shipped !== null &&
				shipped.name === official.name &&
				shipped.symbol === official.symbol &&
				shipped.uri === official.uri;
			console.log(`agree                              : ${agree}`);
		}
	}
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
