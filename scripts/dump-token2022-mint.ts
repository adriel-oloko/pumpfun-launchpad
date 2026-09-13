// Read-only hex dump of a Token-2022 mint account (find where the metadata
// strings live), plus the spl-token getMint view of the same account.
// Sends nothing.
import { Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_2022_PROGRAM_ID, getExtensionTypes, getMint } from "@solana/spl-token";

async function main() {
	const addr = process.argv[2];
	if (!addr) {
		console.error("usage: dump-token2022-mint.ts <mint>");
		process.exit(2);
	}
	const c = new Connection("https://api.mainnet-beta.solana.com", "confirmed");
	const mint = new PublicKey(addr);
	const info = await c.getAccountInfo(mint, "confirmed");
	if (!info) throw new Error("account missing");
	console.log(`account: ${info.data.length} bytes, owner ${info.owner.toBase58()}`);
	const data = info.data;
	for (let i = 0; i < data.length; i += 32) {
		const row = data.subarray(i, i + 32);
		const hex = row.toString("hex").replace(/(..)/g, "$1 ").padEnd(96, " ");
		const ascii = row.toString("latin1").replace(/[^\x20-\x7e]/g, ".");
		console.log(`${String(i).padStart(4, "0")}  ${hex} ${ascii}`);
	}
	const m = await getMint(c, mint, "confirmed", TOKEN_2022_PROGRAM_ID);
	console.log(`getMint: decimals=${m.decimals} supply=${m.supply}`);
	console.log(`tlvData: ${m.tlvData.length} bytes`);
	console.log(`extension types: ${JSON.stringify(getExtensionTypes(m.tlvData))}`);
	console.log(`tlv hex head: ${m.tlvData.subarray(0, 16).toString("hex")}`);
}

main().catch((e) => {
	console.error(e);
	process.exit(1);
});
