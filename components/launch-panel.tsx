"use client";

// Milestone M4: the launch panel (M4-UI-MATCH restyle), M10: native
// pump.fun program.
//
// Form: token name / symbol / metadata URI (direct entry; see the
// Arweave/IPFS decision comment below), the connected creator key (the
// SAME wallet the masthead connects via pumpfun.creatorKey.v1), the
// selected dev wallets, each funded to its planned fill gross budget; the
// creator only covers the create tx + the explicit MigrateV2; wallets must
// hold SOL, fund/disperse them first), and a Launch button that
// drives lib/bundle:
//
//   Tier 1 (default): buildLaunchSequence + preflightLaunch +
//                     sendSequentially, which submits every launch tx
//                     (create -> buys -> migrate) through the shared Helius
//                     Sender SWQOS-only sender on MAINNET (each tx with its
//                     own 0.000005 SOL tip + priority fee, mev-protect) and
//                     through plain RPC on devnet (unchanged).
//   Tier 2:           the same sequence as an ATOMIC relay bundle submitted
//                     through the same-origin proxy (/api/bundle-relay):
//                     NextBlock PRIMARY, Astralane + bloXroute optional
//                     fallbacks. The browser assembles a provider-specific
//                     signed bundle per enabled relay (each pays that
//                     relay's own recognized tip account in its final tx);
//                     the proxy submits them sequentially, NextBlock first,
//                     Astralane/bloXroute only on an explicit reject /
//                     unreachable. Relays are
//                     mainnet services; with no server-side credentials Tier
//                     2 honestly reports the not-configured state after
//                     proving the construction (assemble + simulate). An
//                     accept is NOT a landing: pending accepts are resolved
//                     by a bounded on-chain mint wait.
//
// M10 (native pump.fun): the launch talks to pump.fun's OWN program
// (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P), so every token launched is
// a real pump.fun token: indexed everywhere with the `.pump` suffix (the
// suffix is indexer-applied; the symbol is passed PLAIN). The create args
// are ONLY name/symbol/uri — the old M3 capability gate (auto_migrate /
// lock_lp create args on the CUSTOM program) is GONE: pump.fun
// auto-migrates its curves to PumpSwap on graduation, so the launch panel
// no longer carries migration toggles and no anchor Program/IDL exists
// anymore (every instruction is hand-built in lib/pump.ts; the mint is a
// vanity keypair whose base58 ADDRESS ends in "pump" — ground client-side
// with a libsodium Web Worker pool before the sequence is built).
//
// METADATA (M9: structured + publish-on-launch):
// The single URI input is replaced by discrete description / image /
// social fields. On launch the client posts the fields to the same-origin
// /api/metadata/publish route, which uploads the composed pump.fun-style
// JSON (and the image file when one was picked) to the configured backend
// and returns the on-chain uri. Backend = VPS (preferred,
// tools/metadata-vps/server.mjs) or IPFS via Pinata; server env, see
// lib/metadata-publish.ts + .env.local.example. The image lives INSIDE the
// JSON (standard `image` field), so the stored uri is just the
// metadata.json URL. A "manual metadata uri" toggle in Advanced keeps the
// old direct-URI flow (devnet quick launches / no backend configured). The
// create() arg is still a plain <=200-byte string stored verbatim in the
// mpl metadata account.
//
// M4-UI-MATCH: the layout now mirrors v4-launchpad's Launch card (Card +
// Field + Input + Collapse primitives, "Launch" card head). The status log
// and ALL M4 launch logic are preserved unchanged.

import {
	ComputeBudgetProgram,
	Keypair,
	LAMPORTS_PER_SOL,
	PublicKey,
	SystemProgram,
	TransactionMessage,
	VersionedTransaction,
	type Connection,
	type Transaction,
	type TransactionInstruction,
} from "@solana/web3.js";
import bs58 from "bs58";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
	assembleLaunchBundle,
	ataRentLamports,
	buildLaunchSequence,
	CREATE_BUY_CU_LIMIT,
	ensurePumpLookupTable,
	holderCount,
	postBuyFloorLamports,
	preflightLaunch,
	readToken2022Metadata,
	resolveLaunchCurveSeed,
	sendSequentially,
	simulateBundle,
	walletTokenBalance,
	type BuyAllocation,
} from "../lib/bundle";
import { publishTokenMetadata } from "../lib/metadata";
import { grindVanityMintKeypair } from "../lib/vanity-client";
import {
	fetchRelayPlan,
	defaultTipAccountForRelay,
	RELAY_MIN_TIP_LAMPORTS,
	type RelayId,
	type RelayPlanEntry,
	type BundleSubmissionResult,
} from "../lib/bundle";
import { DEFAULT_JITO_TIP_LAMPORTS } from "../lib/fees";
import { submitBundleViaFanoutWithRetry } from "../lib/bundle/fanout-submit";
import { bundleDropMessage, friendlyTxError } from "../lib/tx-errors";
import { makeAppConnection } from "../lib/connection";
import { solanaNetwork } from "../lib/network";
import { useCreatorWallet } from "../lib/creator-wallet";
import { pubkeyFromSecretKey } from "../lib/managed-wallets";
import { DECIMALS, MAX_BUY_KEEP_SOL_LAMPORTS } from "../lib/params";
import {
	claimCreatorFees,
	isFeeSharingRevert,
	type CreatorClaimReport,
} from "../lib/claim-creator-fee";
import {
	PUMP_BUY_DISCRIMINATOR,
	PUMP_CREATE_V2_DISCRIMINATOR,
	PUMP_EXTEND_ACCOUNT_DISCRIMINATOR,
	PUMP_PROGRAM_ID,
	pumpCreatorVaultPda,
	pumpUserVolumeAccumulatorPda,
	quotePumpFill,
	readPumpCurveState,
	type PumpCurveState,
} from "../lib/pump";
import { canonicalMigratedPoolPda } from "../lib/migrate";
import {
	assertMigratedPool,
	SLOT_CHECK_NOT_EXERCISED,
	LATE_READ_NOT_APPLICABLE,
	type MigratedPoolFacts,
} from "../lib/pool-assertions";
import {
	OnlinePumpAmmSdk,
	boostVaultAta,
	boostVaultAuthorityPda,
} from "@pump-fun/pump-swap-sdk";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";
import {
	formatSolLamports,
	sellAllManagedWallets,
	type SellAllReport,
	type SellOutcome,
} from "../lib/sell-all";
import { POOL_SLIPPAGE_PCT } from "../lib/swap";
import { useToasts } from "./toast-stack";
import {
	Btn,
	Card,
	Collapse,
	ExplorerLink,
	Field,
	Input,
	StatusLine,
} from "./ui";
import type { RosterApi } from "./roster";
import { shortAddress } from "./roster";

const EXPLORER = "https://explorer.solana.com";
/** Explorer cluster query: devnet links need ?cluster=devnet; mainnet none. */
const EXPLORER_QS = solanaNetwork() === "devnet" ? "?cluster=devnet" : "";
/** Default Tier 2 relay tip (SOL) shown in the tip field: 0.001 SOL, the
 *  NextBlock / Astralane / bloXroute minimum and lib/fees default. */
const DEFAULT_TIP_SOL = (
	DEFAULT_JITO_TIP_LAMPORTS / LAMPORTS_PER_SOL
).toString();

/** TEST LAUNCH (no graduate): the gross buy the creator commits in test mode
 *  AND the per-wallet cap for every selected dev wallet's own test buy. Small
 *  by design: it only needs to give each wallet a non-zero token balance to
 *  sell, and it must stay far below the curve fill so the curve stays OPEN (no
 *  graduation, no MigrateV2). */
const TEST_LAUNCH_DEV_BUY_LAMPORTS = BigInt(10_000_000);

function errMsg(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}

/** Human label for one tx-A instruction (the fold's fixed shape: CB limit,
 *  CB price, create_v2, extend_account, ATA createIdempotent, buy). */
function txAIxLabel(ix: TransactionInstruction): string {
	const data = Buffer.from(ix.data);
	if (ix.programId.equals(ComputeBudgetProgram.programId)) {
		if (data[0] === 2) return "CB setComputeUnitLimit";
		if (data[0] === 3) return "CB setComputeUnitPrice";
		return "ComputeBudget";
	}
	if (ix.programId.equals(PUMP_PROGRAM_ID)) {
		const disc = data.subarray(0, 8);
		if (disc.equals(Buffer.from(PUMP_CREATE_V2_DISCRIMINATOR)))
			return "create_v2";
		if (disc.equals(Buffer.from(PUMP_EXTEND_ACCOUNT_DISCRIMINATOR)))
			return "extend_account";
		if (disc.equals(Buffer.from(PUMP_BUY_DISCRIMINATOR))) return "buy";
		return "pump";
	}
	return "ATA createIdempotent";
}

/** Bounded on-chain wait for the launch's FRESH mint account to appear
 *  (commitment "confirmed"). The mint exists only after the create tx inside
 *  the atomic relay bundle executed, so this is the honest ground truth for a
 *  relay ACCEPT that carries no status API — never a fabricated status. */
async function waitForMintOnChain(
	connection: Connection,
	mint: PublicKey,
	timeoutMs: number,
): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		try {
			const info = await connection.getAccountInfo(mint, "confirmed");
			if (info) return true;
		} catch {
			// transient RPC error: keep polling until the deadline
		}
		if (Date.now() > deadline) return false;
		await new Promise((r) => setTimeout(r, 1_500));
	}
}

/** Token amount formatter (trade panel's helper moved with Sell All): raw
 *  base units -> a 4-decimal display string using the program's decimals. */
function fmtTokens(raw: bigint): string {
	return `${(Number(raw) / 10 ** DECIMALS).toFixed(4)}`;
}

export function LaunchPanel({
	roster,
	onLaunched,
	mint,
}: {
	roster: RosterApi;
	/** Called with the mint after a successful launch (pre-fills the trade
	 *  panel's token-address input, mirroring v4's LAUNCH -> trade flow). */
	onLaunched?: (mint: string) => void;
	/** The mint the Trade panel tracks (a launch pre-fills it). Drives the
	 *  Sell All button below the Launch button; null disables it. */
	mint?: string | null;
}) {
	const {
		key: creatorKey,
		pubkey: creatorPubkey,
		connected,
		balanceSol,
	} = useCreatorWallet();
	const { pushToast } = useToasts();

	const [name, setName] = useState("");
	const [symbol, setSymbol] = useState("");
	const [uri, setUri] = useState("https://example.com/m4-ui-launch.json");
	// M9 structured metadata: description / image / socials are
	// auto-published to the configured backend on launch and the returned
	// URL becomes the create() uri. manualMetadata keeps the old single-URI
	// flow (devnet quick launches / no backend configured).
	const [description, setDescription] = useState("");
	const [imageFile, setImageFile] = useState<File | null>(null);
	const [website, setWebsite] = useState("");
	const [twitter, setTwitter] = useState("");
	const [telegram, setTelegram] = useState("");
	const [manualMetadata, setManualMetadata] = useState(false);
	const [advancedOpen, setAdvancedOpen] = useState(false);
	const [tier, setTier] = useState<"1" | "2">("1");
	// TEST LAUNCH (no graduate): create + the creator's own small buy + one
	// small buy per selected keyed dev wallet, skip the fill roster and the
	// MigrateV2, and leave the curve OPEN so Sell All routes through the bonding
	// curve. Explicit, always visible, OFF by default: the normal
	// fill-and-graduate plan is untouched when it is off.
	const [testLaunch, setTestLaunch] = useState(false);
	// Creator dev buy (fill path): folded into tx A, quoted FIRST against the
	// fresh curve, spent from the creator's own SOL. Default 0.05 SOL (the
	// StonkHouse shape); operator-editable.
	const [creatorDevBuySol, setCreatorDevBuySol] = useState("0.05");
	const [tipSol, setTipSol] = useState(DEFAULT_TIP_SOL);
	const [busy, setBusy] = useState(false);
	const [statusLines, setStatusLines] = useState<string[]>([]);
	const [launchError, setLaunchError] = useState<string | null>(null);
	const [lastMint, setLastMint] = useState<string | null>(null);

	const selectedWallets = useMemo(
		() => roster.wallets.filter((w) => roster.checked.has(w.address)),
		[roster.wallets, roster.checked],
	);

	const log = useCallback((line: string) => {
		setStatusLines((prev) => [...prev.slice(-200), line]);
	}, []);

	const clearLog = useCallback(() => setStatusLines([]), []);

	const parseCreator = (): Keypair => {
		if (!creatorKey) {
			throw new Error(
				"creator key missing: connect the base58 secret of the devnet deploy wallet in the masthead",
			);
		}
		const pubkey = pubkeyFromSecretKey(creatorKey);
		if (!pubkey) {
			throw new Error("creator key is not a valid 64-byte base58 secret");
		}
		return Keypair.fromSecretKey(bs58.decode(creatorKey));
	};

	/** Parses the Tier 2 relay tip field (SOL) into lamports. Empty falls
	 *  back to DEFAULT_JITO_TIP_LAMPORTS (0.001 SOL). Any value below the
	 *  1_000_000-lamport (0.001 SOL) floor of the active Tier 2 relays
	 *  (NextBlock primary, Astralane, bloXroute) is rejected up front — a
	 *  sub-floor bundle cannot be accepted. */
	const parseTip = (): number => {
		const raw = tipSol.trim();
		if (raw === "") return DEFAULT_JITO_TIP_LAMPORTS;
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0) {
			throw new Error(
				`tip must be a non-negative SOL amount, got "${raw}"`,
			);
		}
		const lamports = Math.round(n * LAMPORTS_PER_SOL);
		const floor = RELAY_MIN_TIP_LAMPORTS.nextblock;
		if (lamports < floor) {
			throw new Error(
				`tip ${raw} SOL (${lamports} lamports) is below the ${floor}-lamport (0.001 SOL) minimum required by the Tier 2 relays (NextBlock primary / Astralane + bloXroute fallback)`,
			);
		}
		return lamports;
	};

	/** Parses the creator dev buy field (SOL) into lamports. Empty or 0 means
	 *  "no creator buy": tx A stays the legacy create-only tx and every buy is
	 *  packed as before. */
	const parseCreatorDevBuyLamports = (): bigint => {
		const raw = creatorDevBuySol.trim();
		if (raw === "") return BigInt(0);
		const n = Number(raw);
		if (!Number.isFinite(n) || n < 0) {
			throw new Error(
				`creator dev buy must be a non-negative SOL amount, got "${raw}"`,
			);
		}
		return BigInt(Math.round(n * LAMPORTS_PER_SOL));
	};

	const handleLaunch = async () => {
		if (busy) return;
		setBusy(true);
		setLaunchError(null);
		clearLog();
		// Signatures observed as the launch progresses (toast txHash = the first).
		const sentSigs: string[] = [];
		try {
			const creator = parseCreator();

			if (Buffer.byteLength(name, "utf8") > 32)
				throw new Error(
					`name too long (${Buffer.byteLength(name, "utf8")} > 32 bytes)`,
				);
			if (Buffer.byteLength(symbol, "utf8") > 10)
				throw new Error(
					`symbol too long (${Buffer.byteLength(symbol, "utf8")} > 10 bytes)`,
				);

			const isTestLaunch = testLaunch;
			if (!isTestLaunch && selectedWallets.length === 0) {
				throw new Error("select at least one dev wallet in the roster");
			}
			// Keyedness validated UP FRONT (before metadata is published on
			// the backend): watch-only wallets cannot sign buys. TEST LAUNCH
			// dev-buys from EVERY selected dev wallet (plus the creator's own
			// wallet, the reference pack's first buy), so its plan roster is the
			// creator entry followed by the selected dev wallets.
			const rosterForPlan = isTestLaunch
				? [
						{
							address: creator.publicKey.toBase58(),
							key: creatorKey ?? undefined,
						},
						...selectedWallets,
					]
				: selectedWallets;
			const walletKps = rosterForPlan.map((w) => {
				if (!w.key) {
					throw new Error(
						`wallet ${shortAddress(w.address, 6)} has no key (watch-only wallets cannot sign buys)`,
					);
				}
				return { w, kp: Keypair.fromSecretKey(bs58.decode(w.key)) };
			});

			// M9 metadata: resolve the final on-chain uri BEFORE anything
			// hits the chain. Auto mode publishes the structured fields
			// (description / image / socials) to the configured backend (VPS
			// preferred, IPFS via Pinata the alt) and uses the returned URL;
			// manual mode keeps the raw URI field. The create() arg cap is
			// checked on the RESOLVED uri (200 bytes, the program limit).
			let finalUri: string;
			if (manualMetadata) {
				finalUri = uri;
				if (!finalUri.trim()) {
					throw new Error(
						"manual metadata uri is empty: enter a URI or disable the manual toggle",
					);
				}
			} else {
				log("metadata: publishing description / image / socials...");
				try {
					const pub = await publishTokenMetadata({
						name,
						symbol,
						description,
						website,
						twitter,
						telegram,
						image: imageFile,
					});
					finalUri = pub.uri;
					log(
						`metadata: published via ${pub.backend} -> ${finalUri}`,
					);
					if (pub.imageUrl) log(`image   : ${pub.imageUrl}`);
				} catch (e) {
					const msg = errMsg(e);
					if (msg.includes("METADATA BACKEND NOT CONFIGURED")) {
						log(
							"NOTE: no metadata backend is configured on the server.",
						);
						log(
							"  - set METADATA_BACKEND=vps + METADATA_VPS_UPLOAD_URL /",
						);
						log(
							"    METADATA_VPS_BASE_URL / METADATA_VPS_SECRET (preferred,",
						);
						log("    see tools/metadata-vps/server.mjs), OR");
						log("  - set METADATA_BACKEND=ipfs + PINATA_JWT, OR");
						log(
							'  - enable "manual metadata uri" in Advanced for a',
						);
						log("    devnet launch with no backend.");
					}
					throw e;
				}
			}
			if (Buffer.byteLength(finalUri, "utf8") > 200)
				throw new Error(
					`uri too long (${Buffer.byteLength(finalUri, "utf8")} > 200 bytes)`,
				);

			const connection = makeAppConnection();
			log(`=== pumpfun launch (tier ${tier}) ===`);
			log(`creator : ${creator.publicKey.toBase58()}`);
			log(`name/sym: ${name} / ${symbol}`);
			log(`uri     : ${finalUri}`);
			log(
				`program : pump.fun native (6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P)`,
			);
			if (isTestLaunch) {
				log(
					"TEST LAUNCH (no graduate): curve stays OPEN, NO MigrateV2, the creator's own small buy plus one small buy per selected dev wallet",
				);
			} else {
				log(
					`migrate : explicit MigrateV2 after the fill buys (canonical PumpSwap pool; create args = name/symbol/uri only)`,
				);
			}
			// C1: plan the FILL, not MAX. A MAX-sized buy over-quotes (a wallet
			// bigger than the curve's remaining real tokens reverts
			// NotEnoughTokensToBuy), so the launch plans explicit GROSS budgets
			// whose net deposits reach the fresh curve's fill and the graduating
			// buy takes the remaining real tokens. Read the curve seed LIVE
			// (devnet seeds 1 SOL of virtual SOL, mainnet 30 SOL). Each wallet's
			// gross budget is scaled to its spendable balance, so a wallet with
			// more SOL carries more of the fill; the excess stays in the wallet
			// (the program charges its curve-computed cost, never the
			// max_sol_cost ceiling). The creator does NOT fund dev wallets from
			// this pack: any funding happens in a separate, earlier tx, and a dev
			// wallet pays no launch tx fee (its pair's first wallet is the fee
			// payer). Each rent is reserved ONLY when its account does not
			// already exist on-chain, so a re-launch / re-buy that already holds
			// the accounts does not over-reserve and strand SOL:
			//   - Token-2022 ATA: the mint is fresh, so every wallet reserves it.
			//   - creator_vault (PDA keyed by creator): reserved ONLY when the
			//     creator has not launched before.
			//   - user_volume_accumulator (PDA keyed by wallet): reserved ONLY
			//     when that wallet has not bought before.
			const ataRent = await ataRentLamports(connection);
			const creatorVaultRent =
				await connection.getMinimumBalanceForRentExemption(0);
			const userVolumeAccumulatorRent =
				await connection.getMinimumBalanceForRentExemption(106);
			const creatorVaultInfo = await connection.getAccountInfo(
				pumpCreatorVaultPda(creator.publicKey)[0],
				"confirmed",
			);
			const reserveCv = creatorVaultInfo
				? BigInt(0)
				: BigInt(creatorVaultRent);
			const seed = await resolveLaunchCurveSeed(connection);
			const fill = quotePumpFill(
				{
					virtualSolReserves: seed.virtualSolReserves,
					virtualTokenReserves: seed.virtualTokenReserves,
					realTokenReserves: seed.realTokenReserves,
				},
				BigInt(0),
			);
			// A flat 0.002 SOL headroom absorbs the per-buy 125 bps fee floor:
			// the chained net deposits land a few lamports short of the fill, and
			// the graduating buy takes the exact remainder.
			const fillGross = fill.maxSolCost + BigInt(2_000_000);
			// TEST LAUNCH replaces the fill target with one small gross buy per
			// wallet (the creator's own buy AND the cap for each selected dev
			// wallet); the fill/graduation path keeps fillGross unchanged.
			const fillTarget = isTestLaunch
				? TEST_LAUNCH_DEV_BUY_LAMPORTS
				: fillGross;
			// The creator's OWN dev buy is FOLDED into tx A. On the fill path it
			// is the operator's input; the test path keeps its fixed small test
			// buy. It is quoted FIRST and, on the fill path, subtracted from the
			// dev-wallet target so the sequence still reaches the curve fill.
			const creatorDevBuyLamports = parseCreatorDevBuyLamports();
			const devFillTarget = isTestLaunch
				? fillTarget
				: fillGross - creatorDevBuyLamports;
			if (isTestLaunch) {
				log(
					`test buy: creator's own ${(Number(fillTarget) / LAMPORTS_PER_SOL).toFixed(6)} SOL and up to ${(Number(fillTarget) / LAMPORTS_PER_SOL).toFixed(6)} SOL per selected dev wallet, each sized by its spendable capacity (curve NOT filled) -> curve stays OPEN`,
				);
			} else {
				if (creatorDevBuyLamports <= BigInt(0)) {
					throw new Error(
						"creator dev buy must be > 0 on the fill path: enter the creator's own dev buy in the Advanced section (default 0.05 SOL).",
					);
				}
				if (devFillTarget <= BigInt(0)) {
					throw new Error(
						`creator dev buy ${(Number(creatorDevBuyLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL already covers the ${(Number(fillGross) / LAMPORTS_PER_SOL).toFixed(6)} SOL fill gross; lower it so the selected dev wallets carry the remainder.`,
					);
				}
				log(
					`fill    : net ${(Number(fill.costLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL -> gross target ${(Number(fillGross) / LAMPORTS_PER_SOL).toFixed(6)} SOL`,
				);
				log(
					`creator : dev buy ${(Number(creatorDevBuyLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL gross (folded into tx A, quoted FIRST; dev wallets carry the remaining ${(Number(devFillTarget) / LAMPORTS_PER_SOL).toFixed(6)} SOL gross)`,
				);
			}
			const capacities: bigint[] = [];
			let totalCapacity = BigInt(0);
			for (let i = 0; i < walletKps.length; i++) {
				const { w, kp } = walletKps[i];
				const live = BigInt(
					await connection.getBalance(kp.publicKey, "confirmed"),
				);
				const userVolumeInfo = await connection.getAccountInfo(
					pumpUserVolumeAccumulatorPda(kp.publicKey)[0],
					"confirmed",
				);
				const reserveUva = userVolumeInfo
					? BigInt(0)
					: BigInt(userVolumeAccumulatorRent);
				const reserveLamports =
					MAX_BUY_KEEP_SOL_LAMPORTS +
					BigInt(ataRent) +
					reserveCv +
					reserveUva;
				const spendable = live - reserveLamports;
				capacities.push(spendable);
				totalCapacity += spendable;
				log(
					`  dev ${kp.publicKey.toBase58().slice(0, 12)}... balance ${(Number(live) / LAMPORTS_PER_SOL).toFixed(4)} SOL -> spendable ${(Number(spendable) / LAMPORTS_PER_SOL).toFixed(4)} SOL`,
				);
				if (spendable <= BigInt(0)) {
					// TEST LAUNCH: a selected dev wallet that cannot afford a buy is
					// reported and skipped (it simply holds no tokens). The creator
					// entry is index 0 and is never skipped; the fill path keeps the
					// hard error for every wallet.
					if (isTestLaunch && i > 0) {
						log(
							`  skip  ${kp.publicKey.toBase58().slice(0, 12)}... cannot afford a dev buy (balance ${(Number(live) / LAMPORTS_PER_SOL).toFixed(4)} SOL is below the ${(Number(reserveLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL launch reserve); keeping it out of the plan`,
						);
						continue;
					}
					throw new Error(
						`dev wallet ${shortAddress(w.address, 6)} has no spendable SOL: balance ${(Number(live) / LAMPORTS_PER_SOL).toFixed(4)} SOL is below the ${(Number(reserveLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL launch reserve (0.002 SOL post-buy keep + ATA rent + creator_vault + user_volume_accumulator rent). Fund/disperse SOL to the selected dev wallets before launching.`,
					);
				}
			}
			if (!isTestLaunch && totalCapacity < devFillTarget) {
				throw new Error(
					`dev wallets can commit at most ${(Number(totalCapacity) / LAMPORTS_PER_SOL).toFixed(6)} SOL but their share of the fill is ${(Number(devFillTarget) / LAMPORTS_PER_SOL).toFixed(6)} SOL (the creator's own dev buy covers the rest). Fund/disperse more SOL to the selected dev wallets (a separate, earlier tx) before launching.`,
				);
			}
			const buys: BuyAllocation[] = [];
			// The folded creator buy (null when the operator set it to 0).
			let creatorDevBuy: {
				wallet: Keypair;
				solInLamports: bigint;
			} | null = null;
			if (isTestLaunch) {
				// Creator first: the reference launch pack's first buy is the
				// creator's. Then EVERY selected dev wallet that can afford a buy
				// gets one, capped at TEST_LAUNCH_DEV_BUY_LAMPORTS and at its own
				// spendable capacity (the same clamp the fill path uses).
				const creatorBudget =
					fillTarget < capacities[0] ? fillTarget : capacities[0];
				creatorDevBuy = {
					wallet: walletKps[0].kp,
					solInLamports: creatorBudget,
				};
				for (let i = 1; i < walletKps.length; i++) {
					if (capacities[i] <= BigInt(0)) continue;
					const budget =
						fillTarget < capacities[i] ? fillTarget : capacities[i];
					buys.push({
						wallet: walletKps[i].kp,
						solInLamports: budget,
					});
				}
			} else {
				// Proportional GROSS allocation of the DEV share; the last wallet
				// also carries the integer-division remainder so the dev total
				// reaches its target.
				let allocated = BigInt(0);
				for (let i = 0; i < walletKps.length; i++) {
					const isLast = i === walletKps.length - 1;
					let budget = isLast
						? devFillTarget - allocated
						: (capacities[i] * devFillTarget) / totalCapacity;
					if (budget > capacities[i]) budget = capacities[i];
					if (budget < BigInt(0)) budget = BigInt(0);
					allocated += budget;
					buys.push({ wallet: walletKps[i].kp, solInLamports: budget });
				}
				if (creatorDevBuyLamports > BigInt(0)) {
					creatorDevBuy = {
						wallet: creator,
						solInLamports: creatorDevBuyLamports,
					};
				}
			}
			if (creatorDevBuy) {
				log(
					`  plan  creator ${creatorDevBuy.wallet.publicKey.toBase58().slice(0, 12)}... commits ${(Number(creatorDevBuy.solInLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL gross (folded into tx A)`,
				);
			}
			for (const b of buys) {
				log(
					`  plan  ${b.wallet.publicKey.toBase58().slice(0, 12)}... commits ${(Number(b.solInLamports) / LAMPORTS_PER_SOL).toFixed(6)} SOL gross`,
				);
			}

			// The creator funds the create tx AND the explicit MigrateV2 (the
			// pool + LP mint + pool ATAs rent). The pump.fun `create_v2`
			// instruction makes the creator fund the accounts it allocates,
			// all rent-exempt:
			//   - Token-2022 mint (~400-570B; metadata lives IN-MINT via the
			//     Token-2022 metadata extension, growing with the
			//     name/symbol/uri length — there is NO Metaplex account)
			//   - bonding curve (151B on live create_v2 tokens)
			//   - bonding-curve ATA (Token-2022 token account = 170B)
			//   - mayhem_state + mayhem_token_vault: created then CLOSED
			//     for non-mayhem tokens (net zero, but the creator must
			//     cover their rent mid-tx) — reserved as a flat buffer
			// The creator is ALSO the fee payer on the create tx and the
			// MigrateV2 tx, but NOT on the fill buys (each pair's first wallet
			// pays its own fee), so the margin is the create rent + create and
			// migrate base fees + a flat migration-rent reserve for the pool
			// accounts the MigrateV2 creates.
			const mintSize =
				340 +
				Buffer.byteLength(name, "utf8") +
				Buffer.byteLength(symbol, "utf8") +
				Buffer.byteLength(finalUri, "utf8");
			const createRent =
				BigInt(
					await connection.getMinimumBalanceForRentExemption(
						mintSize,
					),
				) + // Token-2022 mint
				BigInt(
					await connection.getMinimumBalanceForRentExemption(151),
				) + // bonding curve
				BigInt(
					await connection.getMinimumBalanceForRentExemption(170),
				) + // Token-2022 ATA
				BigInt(
					await connection.getMinimumBalanceForRentExemption(340),
				) + // mayhem_state (ephemeral)
				BigInt(await connection.getMinimumBalanceForRentExemption(170)); // mayhem_token_vault (ephemeral)
			// Flat reserve for the pool + LP mint + pool ATAs the explicit
			// MigrateV2 creates (the creator is the migrate `user`). 0.05 SOL is
			// comfortably above the measured pool-account rent on both clusters.
			const MIGRATE_RENT_RESERVE_LAMPORTS = BigInt(50_000_000);
			const createMargin =
				createRent +
				postBuyFloorLamports() +
				MIGRATE_RENT_RESERVE_LAMPORTS +
				BigInt(30_000 + 5_000);
			const creatorBal = await connection.getBalance(
				creator.publicKey,
				"confirmed",
			);
			// The creator's own dev buy is FOLDED into tx A, so it is ADDITIONAL
			// creator spend: the margin must include it (the explicit MigrateV2
			// reserve is already inside createMargin and only exists on the
			// graduate path).
			const creatorDevBuySpend = creatorDevBuy
				? creatorDevBuy.solInLamports
				: BigInt(0);
			const requiredMargin = createMargin + creatorDevBuySpend;
			log(
				`fund    : dev wallets spend their OWN SOL; creator covers the create tx${isTestLaunch ? "" : " + MigrateV2"} AND its own ${(Number(creatorDevBuySpend) / LAMPORTS_PER_SOL).toFixed(6)} SOL dev buy (needs >= ${(Number(requiredMargin) / LAMPORTS_PER_SOL).toFixed(4)} SOL)`,
			);
			if (creatorBal < requiredMargin) {
				throw new Error(
					`creator balance ${(Number(creatorBal) / LAMPORTS_PER_SOL).toFixed(4)} SOL too low; need >= ${(Number(requiredMargin) / LAMPORTS_PER_SOL).toFixed(4)} SOL for the create tx${isTestLaunch ? "" : " + MigrateV2"} + the creator's own ${(Number(creatorDevBuySpend) / LAMPORTS_PER_SOL).toFixed(6)} SOL dev buy (rent + floor + fees). Dev wallets are NOT funded from the creator anymore: fund/disperse them first.`,
				);
			}

			// Vanity mint: real pump.fun tokens have base58 mint ADDRESSES
			// ending in the literal string "pump" (pump.fun grinds them
			// client-side). Grind ours with a libsodium Web Worker pool
			// (lib/vanity-client.ts; lib/vanity.ts single-threaded core is the
			// fallback) so the create tx signs with a genuinely "...pump" mint
			// keypair. Cosmetic, zero on-chain effect: name/symbol/uri are
			// untouched — the .pump TICKER suffix is still indexer-applied.
			// The mint secret key is never logged.
			//
			// One status-log slot ('vanity :' lines): the seed line is
			// replaced in place by each throttled progress tick and finally by
			// the found line, so the log does not flood during a ~1-2 min
			// grind.
			const logVanity = (line: string): void => {
				setStatusLines((prev) => {
					const last = prev[prev.length - 1] ?? "";
					return last.startsWith("vanity :")
						? [...prev.slice(0, -1), line]
						: [...prev, line];
				});
			};
			logVanity(
				'vanity : grinding a mint keypair whose ADDRESS ends in "pump" (Web Workers, ~1-2 min)...',
			);
			const mintKeypair = await grindVanityMintKeypair({
				onProgress: (p) =>
					logVanity(
						`vanity : grinding "...pump" mint — ${p.attempts.toLocaleString()} keypairs @ ${p.attemptsPerSecond.toLocaleString()}/s`,
					),
			});
			logVanity(
				`vanity : mint ${mintKeypair.publicKey.toBase58()} — ADDRESS ends in "pump"`,
			);

			// The launch ALT is needed BEFORE the sequence is built: the folded
			// tx A is a V0 message compiled against it. Reuse the cached table for
			// this cluster (a 17-address table is ~0.005 SOL of rent, refundable
			// only after deactivation), creating it once otherwise.
			const ALT_CACHE_KEY = `pumpfun.pumpLookupTable.${solanaNetwork()}`;
			let cachedAlt: string | null = null;
			try {
				cachedAlt = window.localStorage.getItem(ALT_CACHE_KEY);
			} catch {
				// storage unavailable: fall through and create a fresh table
			}
			const { account: lookupTable, address: altAddress } =
				await ensurePumpLookupTable(connection, creator, cachedAlt);
			try {
				window.localStorage.setItem(
					ALT_CACHE_KEY,
					altAddress.toBase58(),
				);
			} catch {
				// storage unavailable: the table still works for this launch
			}
			log(
				`alt     : ${altAddress.toBase58()} (${cachedAlt === altAddress.toBase58() ? "reused" : "created"}; ~0.005 SOL rent, refundable only after deactivation)`,
			);

			const seq = await buildLaunchSequence({
				connection,
				creator,
				name,
				symbol,
				uri: finalUri,
				buys,
				creatorDevBuy,
				lookupTable,
				mintKeypair,
				// ZERO slippage: the plan already sizes the fill, and the buy's
				// max_sol_cost is the fee-grossed-up chunk cost. Any wallet
				// headroom stays in the wallet (the program charges its
				// curve-computed cost).
				slippageBps: BigInt(0),
				// TEST LAUNCH sets graduate: false, which keeps the final buy at
				// its planned share (curve stays OPEN) and suppresses the
				// MigrateV2 automatically. The normal launch keeps the default
				// (graduate: true) and its fill-and-graduate behaviour.
				graduate: !isTestLaunch,
				// No creator -> wallet funding txs INSIDE the pack: every dev
				// wallet buys from its OWN pre-funded balance (the
				// buildLaunchSequence default fundLamportsPerWallet = null emits
				// no fund tx). Funding is a separate, earlier tx.
				// Byte budget: every mainnet-launch buy tx now carries its OWN
				// Helius Sender tip transfer (~90 bytes) — sendSequentially
				// submits through the SWQOS-only sender on mainnet — so buy
				// txs keep the default 1150-byte budget with the 90-byte tip
				// reserve on BOTH tiers (the old tier-1 1222/0 override is
				// gone). Measured (M10): pump.fun buy ixs pack 2 wallets/tx.
			});
			log(
				`mint    : ${EXPLORER}/address/${seq.pda.mint.toBase58()}${EXPLORER_QS} (vanity keypair: the mint ADDRESS ends in "pump"; the .pump TICKER suffix is still indexer-applied)`,
			);
			log(
				`curve   : ${EXPLORER}/address/${seq.pda.curveState.toBase58()}${EXPLORER_QS}`,
			);
			log(`packing : ${seq.buyTxs.length} buy tx(s):`);
			for (const bt of seq.buyTxs) {
				log(`   ${bt.wallets.length} wallets, ${bt.signedSize} bytes`);
			}

			// tx A shape: the folded V0 (or the legacy create-only tx when the
			// creator dev buy is 0). Log the instruction list, the serialized
			// size and the CU ceiling it stamps.
			if (seq.createTx instanceof VersionedTransaction) {
				const msg = TransactionMessage.decompile(seq.createTx.message, {
					addressLookupTableAccounts: [lookupTable],
				});
				log(
					`tx A    : [${msg.instructions.map(txAIxLabel).join(", ")}] ${seq.createTx.serialize().length} bytes, CU limit ${CREATE_BUY_CU_LIMIT}`,
				);
			} else {
				const legacyBytes =
					seq.createTx.serializeMessage().length + 1 + 64 * 2;
				log(
					`tx A    : [${seq.createTx.instructions.map(txAIxLabel).join(", ")}] ~${legacyBytes} bytes (legacy create-only; creator dev buy = 0)`,
				);
			}

			log("preflight: simulating tx A + buy txs...");
			const pre = await preflightLaunch(connection, seq, lookupTable);
			log(`   create: ${pre.create.unitsConsumed} CU, ok`);
			for (const c of pre.buyChunks) {
				log(
					`   buy${c.buyTxIndex + 1} chunk (${c.walletCount}): ${c.result.unitsConsumed} CU, ok`,
				);
			}

			if (tier === "1") {
				log(
					"sending launch txs sequentially (create -> buys -> migrate)...",
				);
				// sendSequentially routes each launch tx through Helius Sender
				// SWQOS-only on mainnet (flat 5,000-lamport tip, LAST
				// instruction, + the tx's own priority fee) and through plain
				// RPC on devnet.
				const sent = await sendSequentially(connection, seq, {
					onSignature: (label, sig) => {
						sentSigs.push(sig);
						log(
							`[${label}] ${sig}  ${EXPLORER}/tx/${sig}${EXPLORER_QS}`,
						);
					},
				});
				log(
					`sent ${sent.length} txs: ${sent.map((s) => s.label).join(", ")}`,
				);
			} else {
				// Tier 2 (atomic relay bundle: NextBlock PRIMARY, Astralane
				// Iris + bloXroute OPTIONAL fallbacks). Relay credentials
				// live server-side; the browser assembles a PROVIDER-SPECIFIC
				// signed bundle per enabled relay (each paying that relay's
				// own recognized tip account) and the same-origin proxy
				// (/api/bundle-relay) submits them sequentially — NextBlock
				// first, Astralane/bloXroute only on an explicit reject /
				// unreachable.
				// M7a: a non-landing bundle must NEVER fall through to the
				// "launch complete" block below, so the tier-2 outcome is
				// captured here and a non-landing result throws before any
				// verification (pending accepts get a bounded on-chain mint
				// wait first — an accept is NOT a landing).
				log("tier 2: assembling atomic relay bundle...");
				const tier2TipLamports = parseTip();
				log(
					`tip     : ${tier2TipLamports} lamports (${(tier2TipLamports / LAMPORTS_PER_SOL).toFixed(6)} SOL)`,
				);
				// Relay plan (ids + configured flags only, no secrets): the
				// SERVER env decides which relays exist. There is no
				// Jito-specific reachability probe on the active path.
				let plan: RelayPlanEntry[] = [];
				try {
					plan = await fetchRelayPlan();
				} catch (e) {
					log(`relay plan fetch failed: ${errMsg(e)}`);
				}
				if (plan.length === 0) {
					log("relay plan: the server reported no relays");
				}
				for (const r of plan) {
					log(
						`relay   : ${r.id} (${r.role}) ${r.configured ? "configured" : "NOT configured (disabled)"}`,
					);
				}
				const enabledRelays = plan
					.filter((r) => r.configured)
					.map((r) => r.id);
				let tier2Result: BundleSubmissionResult | null = null;
				const bundlePack = await assembleLaunchBundle(connection, seq);
				if (bundlePack.migrateDropped) {
					log(
						`tier 2 idempotency: canonical pool ${bundlePack.poolKey.toBase58()} already exists (curve.complete=${bundlePack.curveComplete}); dropping the MigrateV2 tx from the bundle (an atomic bundle cannot swallow its Custom: 6040 revert).`,
					);
				}
				const bundleTxs = bundlePack.txs;
				const bundleSigners = bundlePack.signersByTx;
				// NextBlock / Astralane / bloXroute bundles cap at 4 txs
				// (pump.fun buy ixs pack 2 wallets per tx, measured M10), so
				// a launch over ~6 funded wallets exceeds the cap. Surface
				// that BEFORE the assembler's cryptic cap error with the
				// actionable fix.
				const TIER2_BUNDLE_CAP = 4;
				if (bundleTxs.length > TIER2_BUNDLE_CAP) {
					const nonBuyTxs = bundleTxs.length - seq.buyTxs.length;
					const maxWallets = 2 * (TIER2_BUNDLE_CAP - nonBuyTxs);
					throw new Error(
						`TIER 2 BUNDLE CAP: ${bundleTxs.length} txs > the ${TIER2_BUNDLE_CAP}-tx NextBlock/Astralane/bloXroute bundle limit (pump.fun buy ixs pack 2 wallets per tx). Reduce the selected dev wallets to at most ${maxWallets} or use Tier 1 (sequential sends).`,
					);
				}
				// Representative tip account for the sandbox sim: the PRIMARY
				// configured relay's official tip account (first configured
				// relay in order; the nextblock constant when nothing is
				// configured, so a no-creds rehearsal still proves the
				// construction). The real per-relay tips are chosen inside
				// the submitter for EVERY enabled relay.
				const simRelay: RelayId =
					enabledRelays.length > 0 ? enabledRelays[0] : "nextblock";
				const simTipAccount = new PublicKey(
					defaultTipAccountForRelay(simRelay),
				);
				log(
					`tip acct: ${simTipAccount.toBase58()} (${simRelay}, primary)`,
				);
				const tipIx = SystemProgram.transfer({
					fromPubkey: creator.publicKey,
					toPubkey: simTipAccount,
					lamports: tier2TipLamports,
				});
				const sims = await simulateBundle(connection, {
					createIx: seq.createIx,
					fundIx: seq.fundIx,
					fundIxPerWallet: seq.fundIxPerWallet,
					buyTxs: seq.buyTxs.map((bt) => ({
						wallets: bt.wallets,
						walletIxs: bt.walletIxs,
					})),
					tipIx,
					creator,
					mintKeypair: seq.mintKeypair,
					lookupTable,
				});
				for (const s of sims)
					log(`   ${s.label}: ${s.unitsConsumed} CU, ok`);
				if (enabledRelays.length === 0) {
					// Assembly + simulation proved the construction. Without
					// server-side relay credentials submission is impossible:
					// report the honest not-configured state, never a
					// fabricated landing.
					log(
						"TIER 2 RESULT: bundle assembled + simulated; submission impossible (no relay credentials configured server-side). No fabricated landing claim.",
					);
					throw new Error(
						"TIER 2 NOT CONFIGURED: no Tier 2 relay credentials on the server. Set NEXTBLOCK_API_KEY (primary; docs.nextblock.io) and optionally ASTRALANE_API_KEY / BLOXROUTE_JWT (fallbacks) in the server env — never NEXT_PUBLIC_ — then re-run. NOTHING WAS CREATED. On devnet, Tier 2 relays are mainnet services: use Tier 1 normal sends.",
					);
				} else {
					log(
						`submitting provider-specific bundle variants via relay proxy (${enabledRelays.join(" -> ")})...`,
					);
					// The launch txs are assembled into ONE PROVIDER-SPECIFIC
					// signed bundle per enabled relay (each paying that
					// relay's own recognized tip account in its final tx) and
					// submitted through /api/bundle-relay SEQUENTIALLY:
					// NextBlock primary first, Astralane/bloXroute fallback
					// only when NextBlock explicitly rejects or is
					// unreachable — never simultaneously. Credentials stay
					// server-side; only the
					// signed base64 variants leave this page. Each attempt
					// re-assembles with a fresh blockhash at the same tip
					// (safe: a landed create makes later attempts revert).
					// Tier 2 needs a separate V0 pass: the folded tx A is a
					// VersionedTransaction, but the relay assembler still takes
					// legacy txs (Tier 2 is unreachable today).
					tier2Result = await submitBundleViaFanoutWithRetry({
						txs: bundleTxs as Transaction[],
						signersByTx: bundleSigners,
						tipPayer: creator,
						initialTipLamports: tier2TipLamports,
						relays: enabledRelays,
						pollTimeoutMs: 40_000,
						pollIntervalMs: 2_500,
						connection,
						onAttempt: (a) => {
							const segs = [
								`attempt ${a.attempt}`,
								`tip ${a.tipLamports}`,
								a.bundleId ? `bundle ${a.bundleId}` : "",
								a.status ? `status ${a.status}` : "",
								a.winningRelay ? `relay ${a.winningRelay}` : "",
								a.rejectionReason
									? `reason ${a.rejectionReason}`
									: "",
								a.rejectionMsg ? `msg ${a.rejectionMsg}` : "",
								a.blockhash ? `blockhash ${a.blockhash}` : "",
								a.lastValidBlockHeight != null
									? `lastValidBlockHeight ${a.lastValidBlockHeight}`
									: "",
								a.txSignatures && a.txSignatures.length
									? `sigs ${a.txSignatures.join(",")}`
									: "",
								a.sendError ? `error ${a.sendError}` : "",
							].filter((s) => s !== "");
							log(`   ${segs.join(", ")}`);
						},
					});
					log(
						`TIER 2 RESULT: ${tier2Result.outcome}${tier2Result.bundleId ? ` (bundle ${tier2Result.bundleId})` : ""}${tier2Result.landedSlot != null ? `, landed slot ${tier2Result.landedSlot}` : ""}`,
					);
				}
				// M7a bundle-drop reconciliation: only a LANDED bundle is a
				// launch. Astralane/bloXroute accepts carry no status API, so
				// a pending accept is resolved with a bounded on-chain mint
				// wait (the fresh mint account appears only if the atomic
				// bundle executed). Anything un-landed throws with an honest
				// summary and a retry path; the outer catch turns it into the
				// FAILED toast (no LAUNCHED toast, no trade-panel prefill, no
				// phantom "launch complete").
				let tier2Landed = tier2Result?.outcome === "landed";
				if (tier2Result?.outcome === "pending" && !tier2Landed) {
					log(
						"relay accepted the bundle but exposes no status API — verifying the launch on-chain (mint appearing)...",
					);
					const mintAppeared = await waitForMintOnChain(
						connection,
						seq.pda.mint,
						25_000,
					);
					if (mintAppeared) {
						log(
							"mint confirmed on-chain: the relayed bundle LANDED. Proceeding to verification.",
						);
						tier2Landed = true;
					} else {
						log(
							"mint NOT confirmed on-chain within 25s: the accepted bundle did not land (nothing was created).",
						);
					}
				}
				if (!tier2Result || !tier2Landed) {
					// M7b observability: a rejected bundle leaves a full trace
					// in the log so the culprit class (TransactionFailure /
					// ExceedsCostModel / BlockhashNotFound / TipError /
					// nothing-landed) is identifiable without re-running. The
					// base64 of each attempt's signed txs rides on
					// tier2Result.attempts[].base64 for decoding against the
					// chain (the rejection reason alone cannot name the tx).
					const lastA = tier2Result?.attempts?.length
						? tier2Result.attempts[tier2Result.attempts.length - 1]
						: null;
					const simSummary = sims
						.map((s) => `${s.label} ${s.unitsConsumed ?? "?"} CU`)
						.join(", ");
					log("tier 2 diagnostic (rejected):");
					log(
						`  bundle id            : ${lastA?.bundleId ?? "none"}`,
					);
					log(`  status               : ${lastA?.status ?? "n/a"}`);
					log(
						`  rejection reason     : ${lastA?.rejectionReason ?? "n/a"}`,
					);
					log(
						`  rejection msg        : ${lastA?.rejectionMsg ?? "n/a"}`,
					);
					log(
						`  blockhash            : ${lastA?.blockhash ?? "n/a"}`,
					);
					log(
						`  lastValidBlockHeight : ${lastA?.lastValidBlockHeight ?? "n/a"}`,
					);
					log(
						`  tip (lamports)       : ${lastA?.tipLamports ?? "n/a"}`,
					);
					log(
						`  tx signatures        : ${
							lastA?.txSignatures?.length
								? lastA.txSignatures.join(", ")
								: "n/a"
						}`,
					);
					log(`  sim/preflight        : ${simSummary || "n/a"}`);
					log(
						`  attempts             : ${
							tier2Result
								? tier2Result.attempts
										.map(
											(t) =>
												`#${t.attempt} ${t.status ?? ""}${
													t.rejectionReason
														? ` (${t.rejectionReason})`
														: ""
												}`,
										)
										.join("; ")
								: "n/a"
						}`,
					);
					// Raw signed bundle(s): decode offline to diff every
					// account/PDA against the chain. The active Tier 2 relays
					// expose no rejection_reason / status API, so the signed
					// base64 is the ONLY artifact that names the culprit tx.
					for (const t of tier2Result?.attempts ?? []) {
						if (t.base64?.length) {
							log(
								`  bundle b64 (attempt ${t.attempt}${
									t.bundleId ? `, id ${t.bundleId}` : ""
								}): ${JSON.stringify(t.base64)}`,
							);
						}
					}
					throw new Error(
						tier2Result
							? bundleDropMessage(tier2Result)
							: "TIER 2 BUNDLE HAD NO RESULT: nothing was created.",
					);
				}
			}

			// ---- post-launch verification -------------------------------
			const mint = seq.pda.mint.toBase58();
			const mintPk = seq.pda.mint;
			log("");
			log("=== on-chain verification ===");
			log(`token   : ${EXPLORER}/address/${mint}${EXPLORER_QS}`);
			log(
				`curve   : ${EXPLORER}/address/${seq.pda.curveState.toBase58()}${EXPLORER_QS}`,
			);

			const balances = [];
			for (const b of buys) {
				const bal = await walletTokenBalance(
					connection,
					b.wallet.publicKey,
					mintPk,
				);
				balances.push(bal);
				log(
					`   ${b.wallet.publicKey.toBase58().slice(0, 12)}...  ${(Number(bal) / 1e6).toFixed(6)} tokens`,
				);
			}
			const rosterHolders = balances.filter((b) => b > BigInt(0)).length;
			log(`holders (selected dev roster, non-zero): ${rosterHolders}`);
			try {
				const holders = await holderCount(connection, mintPk);
				log(`holders (getTokenLargestAccounts): ${holders}`);
			} catch {
				log(
					"holders (getTokenLargestAccounts): rate-limited on the public devnet RPC;",
				);
				log(
					"   the selected-wallet roster above is the authoritative count.",
				);
			}
			try {
				// M10: pump.fun curve state (bonding-curve PDA parsed in
				// lib/pump.ts; virtual reserves + the complete flag).
				const curveRead = await readPumpCurveState(connection, mintPk);
				if (curveRead.kind === "ok") {
					const c = curveRead.curve;
					log(
						`curve state: virtualSol=${c.virtualSolReserves} virtualToken=${c.virtualTokenReserves} complete=${c.complete ? 1 : 0}`,
					);
					log(
						`price      : ${(Number(c.virtualSolReserves) / Number(c.virtualTokenReserves)).toFixed(6)} lamports/token`,
					);
					// C4 / section 4 (UI report): after graduation, print the canonical
					// PumpSwap pool + the boost fields. The explicit MigrateV2 runs
					// before this, so a complete curve should have the pool.
					if (c.complete) {
						try {
							const [poolKey] = canonicalMigratedPoolPda(mintPk);
							const pool = await new OnlinePumpAmmSdk(connection).fetchPool(
								poolKey,
							);
							const [baseAcc, quoteAcc] = await Promise.all([
								connection.getTokenAccountBalance(
									pool.poolBaseTokenAccount,
									"confirmed",
								),
								connection.getTokenAccountBalance(
									pool.poolQuoteTokenAccount,
									"confirmed",
								),
							]);
							const boostAuthority = boostVaultAuthorityPda(poolKey);
							const boostVault = boostVaultAta(
								boostAuthority,
								pool.quoteMint,
								TOKEN_PROGRAM_ID,
							);
							let boostBalance = BigInt(0);
							try {
								const b = await connection.getTokenAccountBalance(
									boostVault,
									"confirmed",
								);
								boostBalance = BigInt(b.value.amount);
							} catch {
								// the boost vault ATA is optional/late; a missing account is
								// not fatal (assertion 12 reports it).
							}
							log(`pool       : ${poolKey.toBase58()} (canonical PumpSwap)`);
							// Section 4: the SAME assertion table the devnet runner and the
							// offline tests print, through the same function.
							const facts: MigratedPoolFacts = {
								cluster: solanaNetwork(),
								mint: mintPk,
								curveCreator: c.creator,
								curveComplete: c.complete,
								pool: {
									poolAuthority: pool.creator,
									baseMint: pool.baseMint,
									quoteMint: pool.quoteMint,
									coinCreator: pool.coinCreator,
									poolBaseTokenAccount: pool.poolBaseTokenAccount,
									poolQuoteTokenAccount: pool.poolQuoteTokenAccount,
									virtualQuoteReserves: BigInt(
										pool.virtualQuoteReserves.toString(),
									),
									lpSupply: BigInt(pool.lpSupply.toString()),
									isMayhemMode: pool.isMayhemMode,
									isCashbackCoin: pool.isCashbackCoin,
								},
								vaultBaseRaw: BigInt(baseAcc.value.amount),
								vaultQuoteLamports: BigInt(quoteAcc.value.amount),
								boostVaultAuthority: boostAuthority,
								boostAtaLamports: boostBalance,
							};
							log("=== pool assertions (section 4) ===");
							for (const check of assertMigratedPool(facts, { atMigration: true })) {
								const notEvaluated =
									check.actual === SLOT_CHECK_NOT_EXERCISED ||
									check.actual === LATE_READ_NOT_APPLICABLE;
								const status = check.ok ? "ok  " : notEvaluated ? "n/a " : "FAIL";
								log(
									`  ${status} ${check.name}: expected=${check.expected} actual=${check.actual}`,
								);
							}
						} catch (e) {
							log(`pool report: ${errMsg(e)}`);
						}
					}
				} else {
					log("curve state: not found (create tx did not land?)");
				}
			} catch (e) {
				log(`curve state read failed: ${errMsg(e)}`);
			}
			const meta = await readToken2022Metadata(connection, seq.pda.mint);
			if (meta) {
				log(
					`metadata  : name="${meta.name}" symbol="${meta.symbol}" uri=${meta.uri}`,
				);
			} else {
				log(
					"metadata  : could not decode the Token-2022 in-mint metadata",
				);
			}
			if (isTestLaunch) {
				log(
					"TEST LAUNCH: coin did NOT graduate — the curve remains OPEN and NO MigrateV2 was sent. Sell All will route through the bonding curve.",
				);
			}
			log("=== launch complete ===");

			roster.setTrackedMint(mint);
			setLastMint(mint);
			onLaunched?.(mint);
			// Toast: LAUNCHED, amount = symbol, txHash = the first signature.
			if (tier === "1" && sentSigs.length > 0) {
				pushToast({
					action: "LAUNCHED",
					amount: `$${symbol}`,
					txHash: sentSigs[0],
				});
			}
		} catch (e) {
			const rawMsg = errMsg(e);
			log(`LAUNCH FAILED: ${rawMsg}`);
			if (rawMsg.includes("METADATA BACKEND NOT CONFIGURED")) {
				log(
					'NOTE: metadata backend not configured. Enable "manual metadata',
				);
				log(
					'      uri" in Advanced (devnet) or set METADATA_BACKEND +',
				);
				log(
					"      METADATA_VPS_* / PINATA_JWT in the server env (mainnet).",
				);
			}
			if (e instanceof Error && e.stack) {
				log(e.stack.split("\n").slice(0, 5).join("\n"));
			}
			// M7a error surfacing: rate-limit / expired blockhash / insufficient
			// funds / rent map to actionable text; the raw message stays in the log
			// above for debugging.
			const msg = friendlyTxError(rawMsg);
			log(`LAUNCH FAILED (friendly): ${msg}`);
			setLaunchError(msg);
			// Toast: LAUNCH FAILED. A bundle that did not land is NOT "TX
			// REVERTED": the amount line says BUNDLE DID NOT LAND so the operator
			// knows nothing was created and the retry path from the status log
			// applies. txHash = first signature seen (none when nothing sent).
			const bundleDrop =
				/BUNDLE DID NOT LAND|BUNDLE COULD NOT BE SUBMITTED|TIER 2 NOT CONFIGURED|JITO BUNDLE|TIER 2 BUNDLE/i.test(
					rawMsg,
				);
			pushToast({
				action: "LAUNCH FAILED",
				amount: bundleDrop ? "BUNDLE DID NOT LAND" : "TX REVERTED",
				txHash: sentSigs.length > 0 ? sentSigs[0] : undefined,
				tone: "error",
			});
		} finally {
			setBusy(false);
		}
	};

	// M6 SELL ALL (moved here from the trade card's tab strip 2026-09-04):
	// one button below Launch sells EVERY keyed managed wallet's full token
	// balance of the mint the Trade panel tracks (a launch pre-fills that
	// field). Route on curve state: curve sell while open, PumpSwap pool
	// sell after graduation (lib/sell-all.ts). Ignores the roster checkbox
	// selection like the old tab did.
	const [sellBusy, setSellBusy] = useState(false);
	const [sellError, setSellError] = useState<string | null>(null);
	const [sellReport, setSellReport] = useState<SellAllReport | null>(null);
	// STAGE 2B submit routing, no operator control: the ACTIVE Tier 2 relays
	// are mainnet services, so a mainnet Sell All is ONE atomic relay bundle
	// and devnet stays per-wallet (the library refuses "bundle" on a
	// non-mainnet cluster regardless). The bundle tip payer is the library's
	// own default: the first wallet in FOLD order.
	const keyedCount = roster.wallets.filter((w) => w.key).length;

	const handleSellAll = async () => {
		if (sellBusy) return;
		if (!mint) {
			setSellError(
				"ENTER THE TOKEN MINT IN THE TRADE PANEL TO SELL ALL (A LAUNCH PRE-FILLS IT)",
			);
			return;
		}
		if (keyedCount === 0) {
			setSellError(
				"NO KEYED MANAGED WALLETS TO SELL (IMPORT BASE58 SECRETS IN THE ROSTER FIRST)",
			);
			return;
		}
		setSellBusy(true);
		setSellError(null);
		setSellReport(null);
		const sigs: string[] = [];
		try {
			const connection = makeAppConnection();
			// STAGE 2B: bundle on mainnet (the only cluster with relays),
			// per-wallet on devnet (the library refuses "bundle" there).
			// foldedFloors is passed explicitly (true is the default) so the
			// call site is honest about the folded-floor plan the bundle order
			// depends on.
			const submit =
				solanaNetwork() === "mainnet" ? "bundle" : "perWallet";
			// M10: sellAllManagedWallets signs every sell with the roster
			// Keypairs and hand-builds the pump.fun sell ixs itself (no anchor
			// Program, no IDL) — only the connection + mint + roster are needed.
			const report = await sellAllManagedWallets({
				connection,
				mint: new PublicKey(mint),
				wallets: roster.wallets,
				// The venue band (20), NOT the old hardcoded 5: this is the single
				// source of truth for the band on the curve leg's min_sol_output
				// AND the PumpSwap leg's minQuoteAmountOut. Sell All used to pin 5
				// here, which silently overrode the engine default.
				slippagePct: POOL_SLIPPAGE_PCT,
				submit,
				foldedFloors: true,
			});
			setSellReport(report);
			roster.refreshBalances();
			for (const o of report.outcomes) {
				if (o.signature) sigs.push(o.signature);
			}
			if (report.sold > 0) {
				pushToast({
					action: "SELL ALL",
					amount: `${report.sold} WALLETS SOLD`,
					txHash: sigs[0],
				});
			} else if (report.failed > 0) {
				pushToast({
					action: "SELL ALL",
					amount: "0 SOLD",
					tone: "error",
				});
			} else {
				pushToast({
					action: "SELL ALL",
					amount: "0 SOLD (ALL SKIPPED)",
				});
			}
		} catch (e) {
			const raw = e instanceof Error ? e.message : String(e);
			// M7a: rate-limit / expired blockhash / insufficient-funds / rent
			// map to actionable text instead of a raw RPC dump.
			const msg = friendlyTxError(raw);
			setSellError(msg);
			pushToast({
				action: "SELL ALL FAILED",
				amount: "TX REVERTED",
				tone: "error",
			});
		} finally {
			setSellBusy(false);
		}
	};

	// M11 CLAIM FEES: track the curve state of the mint the Trade panel
	// tracks so the Claim Fees button can disable up front when the mint has
	// no pump.fun curve or the connected wallet is not the recorded creator
	// (the claim handler re-reads the curve anyway before signing).
	const [trackedCurve, setTrackedCurve] = useState<PumpCurveState | null>(
		null,
	);
	const [curvePending, setCurvePending] = useState(false);
	useEffect(() => {
		if (!mint) return;
		let alive = true;
		void (async () => {
			setCurvePending(true);
			try {
				const connection = makeAppConnection();
				const curveRead = await readPumpCurveState(
					connection,
					new PublicKey(mint),
				);
				if (alive) {
					setTrackedCurve(
						curveRead.kind === "ok" ? curveRead.curve : null,
					);
				}
			} catch {
				if (alive) setTrackedCurve(null);
			} finally {
				if (alive) setCurvePending(false);
			}
		})();
		return () => {
			alive = false;
		};
	}, [mint]);

	// M11 CLAIM FEES: sweep the connected creator's accrued pump.fun creator
	// fees for the mint the Trade panel tracks (bonding-curve vault via
	// collect_creator_fee_v2, PumpSwap AMM vault via the pump-swap-sdk when
	// the coin graduated). lib/claim-creator-fee.ts packs both legs into one
	// tx when both apply, signs with the creator key, and returns a report
	// with the claimed lamports per leg plus the explorer signature.
	const [claimBusy, setClaimBusy] = useState(false);
	const [claimError, setClaimError] = useState<string | null>(null);
	const [claimReport, setClaimReport] = useState<CreatorClaimReport | null>(
		null,
	);

	// Disabled when: not connected (no creator key to sign with), the Trade
	// panel tracks no mint, the mint has no pump.fun curve, or the connected
	// wallet is not the mint's recorded creator.
	const claimDisabled =
		!connected ||
		!creatorKey ||
		!mint ||
		claimBusy ||
		curvePending ||
		!trackedCurve ||
		(creatorPubkey !== null &&
			trackedCurve.creator.toBase58() !== creatorPubkey);

	const handleClaimFees = async () => {
		if (claimBusy) return;
		if (!mint) {
			setClaimError(
				"CLAIM FAILED: ENTER THE TOKEN MINT IN THE TRADE PANEL TO CLAIM CREATOR FEES",
			);
			return;
		}
		setClaimBusy(true);
		setClaimError(null);
		setClaimReport(null);
		try {
			const creator = parseCreator();
			const connection = makeAppConnection();
			const report = await claimCreatorFees({
				connection,
				mint: new PublicKey(mint),
				creator,
			});
			setClaimReport(report);
			if (report.signature) {
				pushToast({
					action: "CLAIM FEES",
					amount: `${formatSolLamports(report.totalClaimedLamports)} CLAIMED`,
					txHash: report.signature,
				});
			} else {
				pushToast({
					action: "CLAIM FEES",
					amount: "NOTHING TO CLAIM",
				});
			}
		} catch (e) {
			const raw = e instanceof Error ? e.message : String(e);
			// A sharing-config guard revert is its own status (both claim
			// instructions fail once the vault migrated to fee sharing); it
			// cannot be fixed by retrying.
			if (isFeeSharingRevert(raw)) {
				setClaimError("CLAIM REVERTED (VAULT MIGRATED TO FEE SHARING)");
			} else {
				setClaimError(`CLAIM FAILED: ${friendlyTxError(raw)}`);
			}
			pushToast({
				action: "CLAIM FEES FAILED",
				amount: "TX REVERTED",
				tone: "error",
			});
		} finally {
			setClaimBusy(false);
		}
	};

	return (
		<Card
			head={
				<div className="flex items-center justify-between">
					<span className="label-mono !text-[13px]">Launch</span>
				</div>
			}
			className="flex-1 lg:flex-0 lg:min-w-1/3 lg:sticky lg:top-0 lg:self-start lg:z-30">
			<div className="flex flex-col gap-4">
				<Field label="Token Name">
					<Input
						value={name}
						onChange={(e) => setName(e.target.value)}
						placeholder="Coin name"
						spellCheck={false}
					/>
				</Field>
				<Field label="Token Symbol">
					<Input
						value={symbol}
						onChange={(e) => setSymbol(e.target.value)}
						placeholder="Coin ticker"
						spellCheck={false}
					/>
				</Field>

				<Collapse
					open={advancedOpen}
					onToggle={() => setAdvancedOpen((v) => !v)}
					label="Advanced">
					<div className="lg:col-span-4">
						<div className="flex items-center justify-between gap-2">
							<span className="label-mono opacity-70">
								token metadata · auto-published on launch
							</span>
						</div>
						{manualMetadata ? (
							<div className="reveal-up mt-3">
								<Field label="Metadata URI">
									<Input
										value={uri}
										onChange={(e) => setUri(e.target.value)}
										placeholder="https://.../metadata.json"
										spellCheck={false}
									/>
								</Field>
							</div>
						) : (
							<div className="reveal-up mt-3 grid gap-3 md:grid-cols-2">
								<div className="md:col-span-2">
									<Field label="Description">
										<textarea
											className="input-brutal min-h-[72px] resize-y font-sans"
											value={description}
											onChange={(e) =>
												setDescription(e.target.value)
											}
											placeholder="What the token is for (stored in the metadata JSON)."
											spellCheck={false}
										/>
									</Field>
								</div>
								{/* Token image + socials section: spans the
                                launch container's full width (both grid
                                columns), below the description textarea. */}
								<div className="flex flex-col gap-4 md:col-span-2">
									<Field
										label="Token Image"
										aside={
											imageFile
												? imageFile.name
												: "OPTIONAL - png/jpg/gif/webp/svg"
										}>
										<input
											type="file"
											accept="image/png,image/jpeg,image/gif,image/webp,image/svg+xml"
											className="input-brutal cursor-pointer file:mr-2 file:border-0 file:bg-ink file:px-2 file:py-1 file:font-mono file:text-[10px] file:text-paper file:uppercase"
											onChange={(e) => {
												const f = e.target.files;
												setImageFile(
													f && f.length > 0
														? f[0]
														: null,
												);
											}}
										/>
									</Field>
									<div className="grid md:grid-cols-2 lg:grid-cols-3 gap-4">
										<Field label="Website">
											<Input
												value={website}
												onChange={(e) =>
													setWebsite(e.target.value)
												}
												placeholder="https://yoursite.com"
												spellCheck={false}
											/>
										</Field>
										<Field label="X / Twitter">
											<Input
												value={twitter}
												onChange={(e) =>
													setTwitter(e.target.value)
												}
												placeholder="@handle or https://x.com/handle"
												spellCheck={false}
											/>
										</Field>
										<Field label="Telegram">
											<Input
												value={telegram}
												onChange={(e) =>
													setTelegram(e.target.value)
												}
												placeholder="@handle or https://t.me/group"
												spellCheck={false}
											/>
										</Field>
									</div>
								</div>
							</div>
						)}
					</div>

					{/* Creator's own dev buy: FOLDED into tx A, quoted FIRST
                    against the fresh curve. Default 0.05 SOL (the StonkHouse
                    shape). 0 keeps tx A as the legacy create-only tx. */}
					<div className="lg:col-span-4">
						<Field
							label="Creator Dev Buy (SOL)"
							aside="folded into tx A">
							<Input
								value={creatorDevBuySol}
								onChange={(e) =>
									setCreatorDevBuySol(e.target.value)
								}
								placeholder="0.05"
								spellCheck={false}
							/>
						</Field>
					</div>

					{/* Buy sizing for the selected dev wallets: MAX. Every
                    wallet commits its TOTAL balance down to a flat 0.002 SOL
                    keep (the same sizing as the manual Buy Max; see the
                    launch handler). The creator does NOT fund dev
                    wallets, fund/disperse them first. */}
					<div className="lg:col-span-4">
						<div className="flex items-center gap-3">
							<span className="label-mono opacity-70">
								dev wallets (selected in the roster)
							</span>
							<span className="label-mono ml-auto opacity-60">
								{selectedWallets.length} selected
							</span>
						</div>
						{/* Selected dev wallets as pills: each commits MAX (its
                        TOTAL balance down to the flat 0.002 SOL keep) at launch.
                        The x on a pill's right DESELECTS it (checked-set only:
                        the wallet stays in the roster; watch-only wallets get
                        a dimmed WATCH tag and cannot sign launch buys). */}
						<div className="reveal-up mt-3 flex flex-wrap items-center gap-2">
							{selectedWallets.length === 0 ? (
								<span className="label-mono opacity-50">
									none selected — check dev wallets in the roster
								</span>
							) : (
								selectedWallets.map((w) => (
									<span
										key={w.address}
										title={
											w.key
												? "MAX buy: TOTAL balance down to the flat 0.002 SOL keep"
												: "WATCH-ONLY: no secret key, cannot sign launch buys"
										}
										className="label-mono bg-transparent inline-flex items-center gap-1.5 border-2 border-[#3a4956] rounded-full bg-paper p-2 text-[11px]">
										<span
											className={
												w.key ? "" : "opacity-60"
											}>
											{shortAddress(w.address, 6)}
										</span>
										{!w.key ? (
											<span className="opacity-40">
												WATCH
											</span>
										) : null}
										<button
											type="button"
											onClick={() =>
												roster.uncheckWallet(w.address)
											}
											title="deselect: removes this wallet from the launch buys"
											aria-label={`deselect ${w.address}`}
											className="-mr-0.5 p-0.5 leading-none opacity-60 transition-colors duration-150 hover:bg-ink hover:text-paper hover:opacity-100">
											×
										</button>
									</span>
								))
							)}
						</div>
					</div>
				</Collapse>

				{launchError ? (
					<StatusLine
						text={`LAST ERROR: ${launchError}`}
						tone="error"
					/>
				) : null}
				{lastMint ? (
					<div className="flex items-center gap-2">
						<StatusLine text="LAST MINT:" />
						<ExplorerLink hash={lastMint} kind="address" />
					</div>
				) : null}

				<div className="border-t-2 border-white pt-3 hidden">
					<label
						className="label-mono flex cursor-pointer items-start gap-2"
						title="create the coin and dev-buy it from the creator WITHOUT filling/graduating the curve; no MigrateV2; Sell All then routes through the bonding curve">
						<input
							type="checkbox"
							checked={testLaunch}
							onChange={(e) => setTestLaunch(e.target.checked)}
							disabled={busy}
						/>
						<span>
							TEST LAUNCH (no graduate) — create + ONE small dev
							buy from the creator; curve stays OPEN; NO MigrateV2
						</span>
					</label>
				</div>

				<div className="flex flex-wrap items-center justify-between gap-2 border-t-2 border-white pt-3">
					<div className="flex items-center gap-2">
						<span
							className="label-mono flex items-center gap-1.5 opacity-80"
							title="Helius Sender SWQOS-only tip, fixed at 0.000005 SOL (5,000 lamports) — set in lib/bundle/protected-send.ts.">
							tip 0.000005 SOL
						</span>
						<Btn
							onClick={() => void handleLaunch()}
							disabled={busy || !connected}>
							{busy ? "LAUNCHING..." : "Launch"}
						</Btn>
					</div>
					<span className="label-mono opacity-60">
						{!connected
							? "CONNECT CREATOR KEY IN THE MASTHEAD"
							: `CREATOR ${creatorPubkey ? shortAddress(creatorPubkey, 6) : ""} · ${balanceSol}`}
					</span>
				</div>

				{/* Sell All (M6, moved here from the trade card's tab strip
                2026-09-04) + Claim Fees (M11): the SELL ALL tab became this
                always-visible button below Launch, with the Claim Fees
                button on the SAME line. Sell All ignores the roster checkbox
                selection and sweeps every keyed managed wallet's full
                balance of the mint the Trade panel tracks; Claim Fees sweeps
                the CONNECTED CREATOR's accrued pump.fun creator fees for
                that same mint. Status lines for both stay full-width BELOW
                the button row. */}
				<div className="border-t-2 border-white pt-3">
					<div className="flex gap-2">
						<Btn
							invert
							onClick={() => void handleSellAll()}
							disabled={sellBusy || !mint || keyedCount === 0}
							className="flex-1 shadow-none!">
							{sellBusy ? "Selling..." : "Sell All"}
						</Btn>
						<Btn
							onClick={() => void handleClaimFees()}
							disabled={claimDisabled}
							className="flex-1">
							{claimBusy ? "Claiming..." : "Claim Fees"}
						</Btn>
					</div>

					{/* No submit control: a mainnet Sell All is always ONE atomic
					relay bundle (tip paid by the first FOLD wallet), and devnet
					is always per-wallet because every relay is a mainnet
					service. The line below is the routing fact, not a choice. */}
					<div className="mt-2 flex flex-wrap items-center gap-2">
						<span className="label-mono opacity-60">
							{solanaNetwork() === "mainnet"
								? "SUBMIT: BUNDLE (ONE ATOMIC RELAY BUNDLE, FOLD ORDER)"
								: "SUBMIT: PER-WALLET (NO RELAYS ON DEVNET)"}
						</span>
					</div>

					{mint && keyedCount === 0 ? (
						<StatusLine
							text="NO KEYED WALLETS. IMPORT BASE58 SECRETS IN THE ROSTER FIRST"
							tone="idle"
						/>
					) : null}
					{sellError ? (
						<StatusLine
							text={`SELL ALL FAILED: ${sellError}`}
							tone="error"
						/>
					) : null}
					{sellBusy ? (
						<StatusLine
							text="SELLING EVERY KEYED WALLET'S FULL BALANCE (CONCURRENT)..."
							tone="idle"
						/>
					) : null}
					{mint && !curvePending && !trackedCurve ? (
						<StatusLine
							text="NO PUMP.FUN CURVE FOR THIS MINT (NOT A LAUNCHED TOKEN)"
							tone="idle"
						/>
					) : null}
					{mint &&
					!curvePending &&
					trackedCurve &&
					creatorPubkey &&
					trackedCurve.creator.toBase58() !== creatorPubkey ? (
						<StatusLine
							text="CONNECTED WALLET IS NOT THIS MINT'S CREATOR"
							tone="idle"
						/>
					) : null}
					{claimError ? (
						<StatusLine text={claimError} tone="error" />
					) : null}
					{claimBusy ? (
						<StatusLine
							text="CLAIMING ACCRUED CREATOR FEES..."
							tone="idle"
						/>
					) : null}
					{claimReport ? (
						<ClaimFeesStatusView report={claimReport} />
					) : null}
					{sellReport ? (
						<SellAllReportView report={sellReport} />
					) : null}
				</div>

				{/* status log (preserved from M4) */}
				<div>
					<div className="mb-1">
						<span className="label-mono opacity-50">log</span>
					</div>
					<pre className="min-h-[120px] max-h-[260px] overflow-auto tab-content bg-transparent! text-paper p-3 font-mono text-[11px] leading-relaxed whitespace-pre-wrap">
						{statusLines.length === 0
							? "ready. fill the form and press launch."
							: statusLines.join("\n")}
					</pre>
				</div>
			</div>
		</Card>
	);
}

/* ---------- M6 sell-all report (final count, per-wallet SOL, holders) ---------- */

function SellAllReportView({ report }: { report: SellAllReport }) {
	const routeLabel =
		report.route === "curve"
			? `ROUTE: CURVE SELL (NOT GRADUATED) · creator ${shortAddress(report.creator, 6)}`
			: `ROUTE: PUMSWAP SELL (GRADUATED) · pool ${shortAddress(report.poolKey ?? "", 6)}`;
	const bundle = report.submit === "bundle";
	const submitLabel = bundle
		? `SUBMIT: BUNDLE${report.bundleRelay ? ` (relay ${report.bundleRelay})` : ""}`
		: "SUBMIT: PER-WALLET";
	const soldOutcomes = report.outcomes.filter((o) => o.status === "sold");
	// The operator's pass criterion: EVERY transaction landed on the FIRST
	// attempt. Per-wallet: no sold wallet needed a retry / re-quote. Bundle:
	// the atomic bundle landed on its first submission attempt.
	const retried = soldOutcomes.filter(
		(o) => (o.attempts ?? 1) > 1 || o.retriedOnSlippage === true,
	);
	const firstAttemptAll =
		report.failed === 0 &&
		soldOutcomes.length > 0 &&
		(bundle ? (report.bundleAttempts ?? 1) === 1 : retried.length === 0);
	const headline =
		report.failed > 0
			? bundle
				? "FIRST ATTEMPT: NO — BUNDLE DID NOT LAND"
				: "FIRST ATTEMPT: NO — RUN FAILED"
			: soldOutcomes.length === 0
				? "FIRST ATTEMPT: N/A (NOTHING TO SELL)"
				: firstAttemptAll
					? `FIRST ATTEMPT: ALL LANDED FIRST TRY (${soldOutcomes.length} SOLD)`
					: bundle
						? `FIRST ATTEMPT: NO — BUNDLE NEEDED ${report.bundleAttempts ?? "?"} ATTEMPT(S)`
						: `FIRST ATTEMPT: NO — ${retried.length} WALLET(S) NEEDED RETRIES`;
	const bundleFailure = report.outcomes.find(
		(o) => o.address === "bundle" && o.status === "failed",
	);
	return (
		<div className="reveal-up flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
			<p className="label-mono !text-[10px] font-bold break-all">
				{routeLabel}
			</p>
			<p className="label-mono !text-[10px] break-all">
				{submitLabel}
			</p>
			<p className="label-mono !text-[11px] font-bold">
				{headline}
			</p>
			{bundle ? (
				<p className="label-mono !text-[10px] break-all opacity-90">
					RELAY RESULT:{" "}
					{report.failed === 0
						? `${report.bundleRelay ?? "RELAY"} ACCEPTED, LANDED ON ATTEMPT ${report.bundleAttempts ?? 1}${report.bundleId ? ` · bundle ${report.bundleId}` : ""}`
						: (bundleFailure?.reason ??
							report.bundleNote ??
							"BUNDLE DID NOT LAND")}
				</p>
			) : null}
			<p className="label-mono !text-[11px] font-bold">
				SOLD {report.sold}/{report.total} · SKIPPED {report.skipped} ·
				FAILED {report.failed}
			</p>
			<div className="flex flex-col gap-0.5">
				{report.outcomes.map((o) => (
					<SellOutcomeRow key={o.address} outcome={o} />
				))}
			</div>
			<p className="label-mono !text-[10px] border-t border-ink/40 pt-1">
				HOLDERS AFTER:{" "}
				{report.holderCountAfter === null
					? "READ FAILED (RATE-LIMITED); CHECK ROSTER TOKEN COLUMN"
					: `${report.holderCountAfter}`}
			</p>
		</div>
	);
}

function SellOutcomeRow({ outcome }: { outcome: SellOutcome }) {
	const addr = shortAddress(outcome.address, 6);
	const attempts = outcome.attempts ?? 1;
	// R4/STAGE 2B: the pass criterion is visible per row — every transaction's
	// ATTEMPTS count, plus the slippage re-quote flag when one happened.
	const retryNote =
		outcome.status === "sold" && outcome.retriedOnSlippage
			? " · RE-QUOTED (SLIPPAGE)"
			: "";
	let body;
	if (outcome.status === "sold") {
		body = (
			<span>
				SOLD {fmtTokens(outcome.tokenSold)} TOK →{" "}
				{formatSolLamports(outcome.solReceivedLamports)}
				{retryNote}
				{` · ATTEMPTS ${attempts}`}
				{outcome.signature ? (
					<span className="ml-1">
						<ExplorerLink hash={outcome.signature} />
					</span>
				) : null}
			</span>
		);
	} else if (outcome.status === "skipped") {
		body = (
			<span>SKIPPED ({outcome.reason ?? "no key / zero balance"})</span>
		);
	} else {
		body = (
			<span>
				FAILED · ATTEMPTS {attempts} ({outcome.reason ?? "error"})
				{outcome.lastFailedSignature ? (
					<span className="ml-1">
						<ExplorerLink hash={outcome.lastFailedSignature} />
					</span>
				) : null}
			</span>
		);
	}
	return (
		<p className="label-mono !text-[10px] break-all opacity-90">
			{addr} {body}
		</p>
	);
}

/* ---------- M11 claim-fees report (bonding-curve + PumpSwap legs) ---------- */

function ClaimFeesStatusView({ report }: { report: CreatorClaimReport }) {
	const bondLine =
		"claimedLamports" in report.bond
			? `BONDING CURVE: CLAIMED ${formatSolLamports(report.bond.claimedLamports)}`
			: `BONDING CURVE: ${report.bond.skipped}`;
	const ammLine = report.amm
		? "claimedLamports" in report.amm
			? `PUMP SWAP: CLAIMED ${formatSolLamports(report.amm.claimedLamports)}`
			: `PUMP SWAP: ${report.amm.skipped}`
		: "PUMP SWAP: NOT GRADUATED (NO AMM FEES YET)";
	return (
		<div className="reveal-up flex flex-col gap-1 border-2 border-ink px-2 py-1.5">
			<p className="label-mono !text-[11px] font-bold">
				CLAIMED {formatSolLamports(report.totalClaimedLamports)} ·{" "}
				{report.graduated ? "GRADUATED" : "ON BONDING CURVE"}
			</p>
			<p className="label-mono !text-[10px] break-all opacity-90">
				{bondLine}
			</p>
			<p className="label-mono !text-[10px] break-all opacity-90">
				{ammLine}
			</p>
			{report.signature ? (
				<p className="label-mono !text-[10px] border-t border-ink/40 pt-1">
					<ExplorerLink hash={report.signature} />
				</p>
			) : null}
		</div>
	);
}
