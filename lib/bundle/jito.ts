// Milestone M2: Jito bundle assembly and submission.
//
// A Jito bundle is up to 5 transactions, executed sequentially and atomically
// in one slot, all-or-nothing. Rules implemented here (from KNOWLEDGE-BASE.md
// and the live Jito block-engine API):
//
// - Every tx in the bundle shares ONE recent blockhash.
// - The tip (a SOL transfer, minimum 1000 lamports) sits in the LAST tx of
//   the bundle, paid to one of the 8 tip accounts returned by getTipAccounts.
// - sendBundle takes base64-encoded signed txs, no auth header.
// - On rejection, re-submit with an escalating tip (no gas-price games; Solana
//   has no nonces or gas prices). Never hang: each poll is bounded.
//
// Devnet reality (verified at build time): devnet.block-engine.jito.wtf does
// not resolve, so devnet bundles cannot land. The construction stays fully
// testable without Jito (Tier 1 sends the same txs as normal transactions),
// and encoding + tip are validated against the reachable mainnet endpoint.

import { JitoJsonRpcClient } from "jito-js-rpc";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from "@solana/web3.js";
import type { AddressLookupTableAccount } from "@solana/web3.js";
import { MAX_COMPUTE_UNITS, buildSandboxV0, setBlockhash, signTx } from "./launch";
import { ComputeBudgetProgram } from "@solana/web3.js";
import { DEFAULT_JITO_TIP_LAMPORTS } from "../fees";

/** Jito block-engine JSON-RPC base URLs. */
export const JITO_MAINNET_ENDPOINT = "https://mainnet.block-engine.jito.wtf/api/v1";
export const JITO_DEVNET_ENDPOINT = "https://devnet.block-engine.jito.wtf/api/v1";

/** Two well-known tip accounts (verified present in the live mainnet list). */
export const KNOWN_TIP_ACCOUNTS: string[] = [
  "96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5",
  "HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe",
];

/** Minimum Jito tip, lamports. */
export const MIN_TIP_LAMPORTS = 1000;

export interface BundleAssembly {
  /** The signed bundle txs (clones; the input txs are never mutated). */
  signedTxs: Transaction[];
  /** base64-encoded signed txs, ready for sendBundle. */
  base64: string[];
  tipAccount: PublicKey;
  tipLamports: number;
  blockhash: string;
}

export interface BundleAttempt {
  attempt: number;
  tipLamports: number;
  bundleId?: string;
  status?: string;
  landedSlot?: number | null;
  sendError?: string;
}

export interface BundleSubmissionResult {
  outcome: "landed" | "rejected" | "pending" | "unreachable";
  bundleId?: string;
  landedSlot?: number | null;
  attempts: BundleAttempt[];
  note?: string;
}

function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message;
  return String(e);
}

/** Clones a Transaction without mutating the original (safe to reuse). */
function cloneTx(tx: Transaction): Transaction {
  const c = new Transaction({
    feePayer: tx.feePayer as PublicKey,
    blockhash: tx.recentBlockhash as string,
    lastValidBlockHeight: tx.lastValidBlockHeight ?? 0,
  });
  c.add(...tx.instructions);
  return c;
}

export class JitoBundleClient {
  public readonly rpc: JitoJsonRpcClient;

  constructor(public readonly endpoint: string) {
    this.rpc = new JitoJsonRpcClient(endpoint);
  }

  /** Live tip-account list from the block engine. */
  async getTipAccounts(): Promise<string[]> {
    const r = await this.rpc.getTipAccounts();
    if (r.error) throw new Error(`getTipAccounts: ${r.error.message}`);
    if (!r.result) throw new Error("getTipAccounts: empty result");
    return r.result;
  }

  /** Picks a tip account, preferring the caller's choice if still valid. */
  async pickTipAccount(preferred?: string): Promise<string> {
    const accounts = await this.getTipAccounts();
    if (preferred && accounts.includes(preferred)) return preferred;
    if (accounts.length === 0) throw new Error("getTipAccounts returned an empty list");
    return accounts[Math.floor(Math.random() * accounts.length)];
  }

  /** Cross-checks KNOWN_TIP_ACCOUNTS against the live list. */
  async verifyKnownTipAccounts(): Promise<{
    live: string[];
    known: string[];
    missing: string[];
  }> {
    const live = await this.getTipAccounts();
    return {
      live,
      known: [...KNOWN_TIP_ACCOUNTS],
      missing: KNOWN_TIP_ACCOUNTS.filter((k) => !live.includes(k)),
    };
  }

  /**
   * Assembles a bundle: clones every tx, sets the shared blockhash, appends
   * the tip transfer to the LAST tx, signs all, base64-encodes. The input txs
   * are left untouched so retries can re-assemble with a higher tip.
   */
  async assembleBundle(opts: {
    txs: Transaction[];
    signersByTx: Keypair[][];
    blockhash: string;
    lastValidBlockHeight: number;
    tipAccount: PublicKey;
    tipLamports: number;
    tipPayer: Keypair;
  }): Promise<BundleAssembly> {
    const {
      txs,
      signersByTx,
      blockhash,
      lastValidBlockHeight,
      tipAccount,
      tipLamports,
      tipPayer,
    } = opts;
    if (txs.length === 0) throw new Error("no txs to bundle");
    if (txs.length > 5) {
      throw new Error(`bundle cap is 5 txs, got ${txs.length}; pack more wallets per tx`);
    }
    if (tipLamports < MIN_TIP_LAMPORTS) {
      throw new Error(`tip ${tipLamports} lamports below the ${MIN_TIP_LAMPORTS} minimum`);
    }
    const clones = txs.map(cloneTx);
    const tipIx = SystemProgram.transfer({
      fromPubkey: tipPayer.publicKey,
      toPubkey: tipAccount,
      lamports: tipLamports,
    });
    // The tip MUST be in the last tx of the bundle.
    clones[clones.length - 1].add(tipIx);
    for (const tx of clones) setBlockhash(tx, blockhash, lastValidBlockHeight);
    const signedTxs = clones.map((tx, i) => signTx(tx, signersByTx[i]));
    const base64 = signedTxs.map((tx) => tx.serialize().toString("base64"));
    return { signedTxs, base64, tipAccount, tipLamports, blockhash };
  }

  /** sendBundle with base64 encoding. Returns the bundle id. */
  async sendBundle(base64: string[]): Promise<string> {
    const r = await this.rpc.sendBundle([base64, { encoding: "base64" }]);
    if (r.error) {
      const data = r.error.data ? ` (${JSON.stringify(r.error.data)})` : "";
      throw new Error(`sendBundle: ${r.error.message}${data}`);
    }
    if (!r.result) throw new Error("sendBundle: empty result");
    return r.result;
  }

  /** In-flight status of a bundle id (Invalid/Pending/Failed/Landed). */
  async inflightStatus(bundleId: string): Promise<{ status: string; landedSlot: number | null } | null> {
    const r = await this.rpc.getInFlightBundleStatuses([[bundleId]]);
    if (r.error) throw new Error(`getInFlightBundleStatuses: ${r.error.message}`);
    const v = r.result?.value;
    if (!v || v.length === 0) return null;
    return { status: v[0].status, landedSlot: v[0].landed_slot ?? null };
  }

  /** Polls until a final status or the timeout. Never hangs. */
  async pollUntilFinal(
    bundleId: string,
    timeoutMs: number,
    intervalMs: number
  ): Promise<{ status: string; landedSlot: number | null } | "timeout"> {
    const start = Date.now();
    for (;;) {
      const s = await this.inflightStatus(bundleId).catch(() => null);
      if (s && (s.status === "Landed" || s.status === "Failed" || s.status === "Invalid")) {
        return s;
      }
      if (Date.now() - start > timeoutMs) return "timeout";
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  }

  /**
   * Submits the bundle with an escalating tip on failure. Each attempt uses a
   * fresh shared blockhash, re-assembles with tip * 2^attempt, sends, and
   * polls for a final status. Bounded: maxAttempts * (send + poll window).
   */
  async submitWithRetry(opts: {
    txs: Transaction[];
    signersByTx: Keypair[][];
    tipPayer: Keypair;
    tipAccount?: PublicKey;
    /** Initial tip in lamports; when omitted, lib/fees.ts DEFAULT_JITO_TIP_LAMPORTS
     *  applies (env-tunable via NEXT_PUBLIC_JITO_TIP_LAMPORTS). Escalates 2x
     *  per failed attempt. */
    initialTipLamports?: number;
    maxAttempts?: number;
    pollTimeoutMs?: number;
    pollIntervalMs?: number;
    connection: Connection;
    onAttempt?: (a: BundleAttempt) => void;
  }): Promise<BundleSubmissionResult> {
    const { txs, signersByTx, tipPayer, connection } = opts;
    const initialTipLamports = opts.initialTipLamports ?? DEFAULT_JITO_TIP_LAMPORTS;
    const maxAttempts = opts.maxAttempts ?? 3;
    const pollTimeoutMs = opts.pollTimeoutMs ?? 40_000;
    const pollIntervalMs = opts.pollIntervalMs ?? 2_500;
    let tipAccount = opts.tipAccount;
    const attempts: BundleAttempt[] = [];

    for (let i = 0; i < maxAttempts; i++) {
      const tipLamports = Math.max(MIN_TIP_LAMPORTS, initialTipLamports * 2 ** i);
      if (!tipAccount) {
        try {
          tipAccount = new PublicKey(await this.pickTipAccount());
        } catch (e) {
          attempts.push({
            attempt: i + 1,
            tipLamports,
            sendError: `tip accounts: ${errMsg(e)}`,
          });
          if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
          continue;
        }
      }

      let latest: { blockhash: string; lastValidBlockHeight: number };
      try {
        latest = await connection.getLatestBlockhash("confirmed");
      } catch (e) {
        // A transient RPC failure fetching the blockhash must not abort the
        // whole submission: record the attempt and retry on the next loop.
        attempts.push({ attempt: i + 1, tipLamports, sendError: `blockhash: ${errMsg(e)}` });
        if (opts.onAttempt) opts.onAttempt(attempts[attempts.length - 1]);
        continue;
      }

      let assembled: BundleAssembly;
      try {
        assembled = await this.assembleBundle({
          txs,
          signersByTx,
          blockhash: latest.blockhash,
          lastValidBlockHeight: latest.lastValidBlockHeight,
          tipAccount,
          tipLamports,
          tipPayer,
        });
      } catch (e) {
        attempts.push({ attempt: i + 1, tipLamports, sendError: `assemble: ${errMsg(e)}` });
        break;
      }

      let bundleId: string;
      try {
        bundleId = await this.sendBundle(assembled.base64);
      } catch (e) {
        attempts.push({ attempt: i + 1, tipLamports, sendError: errMsg(e) });
        continue;
      }

      const status = await this.pollUntilFinal(bundleId, pollTimeoutMs, pollIntervalMs);
      const attempt: BundleAttempt = { attempt: i + 1, tipLamports, bundleId };
      if (status !== "timeout") {
        attempt.status = status.status;
        attempt.landedSlot = status.landedSlot;
      }
      attempts.push(attempt);
      if (opts.onAttempt) opts.onAttempt(attempt);

      if (status === "timeout") {
        return {
          outcome: "pending",
          bundleId,
          attempts,
          note: "no final status within the poll window; the bundle may still land",
        };
      }
      if (status.status === "Landed") {
        return { outcome: "landed", bundleId, landedSlot: status.landedSlot, attempts };
      }
      // Failed / Invalid: escalate the tip and re-submit.
    }
    return { outcome: "rejected", attempts, note: "all attempts rejected or failed to land" };
  }
}

/**
 * Pre-flight simulation of the assembled bundle txs against the live chain.
 * The create tx simulates standalone; each buy wallet simulates inside a
 * sandbox that runs the create instruction first (one wallet per sandbox:
 * measured M10 — the pump.fun create ix plus ONE wallet's ATA-create + buy
 * ixs already reach ~1120 bytes, so 2 wallets overflow the 1232-byte
 * serialization limit). Every sandbox/standalone create is signed by the
 * creator AND the mint keypair. Any failed simulation is a hard error.
 */
export async function simulateBundle(
  connection: Connection,
  opts: {
    createIx: TransactionInstruction;
    buyTxs: { wallets: Keypair[]; walletIxs: TransactionInstruction[][] }[];
    fundIx?: TransactionInstruction[] | null;
    fundIxPerWallet?: TransactionInstruction[] | null;
    tipIx?: TransactionInstruction | null;
    creator: Keypair;
    mintKeypair: Keypair;
    lookupTable?: AddressLookupTableAccount;
  }
): Promise<{ label: string; unitsConsumed: number | null }[]> {
  const { createIx, buyTxs, fundIx, fundIxPerWallet, tipIx, creator, mintKeypair, lookupTable } = opts;
  const fundIxs = fundIx ?? [];
  const latest = await connection.getLatestBlockhash("confirmed");
  const results: { label: string; unitsConsumed: number | null }[] = [];

  const createTx = new Transaction({ feePayer: creator.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: 0 });
  createTx.add(...fundIxs.slice(0, 2), createIx);
  const r = await connection.simulateTransaction(createTx, [creator, mintKeypair]);
  if (r.value.err) {
    throw new Error(`bundle sim: create failed: ${JSON.stringify(r.value.err)}`);
  }
  results.push({ label: "create", unitsConsumed: r.value.unitsConsumed ?? null });

  let walletOffset = 0;
  for (let i = 0; i < buyTxs.length; i++) {
    const bt = buyTxs[i];
    for (let w = 0; w < bt.wallets.length; w++) {
      const wallet = bt.wallets[w];
      const chunkIxs = bt.walletIxs[w];
      const chunkFundIx = fundIxPerWallet
        ? [fundIxPerWallet[walletOffset + w]]
        : [];
      const isLast = i === buyTxs.length - 1 && w === bt.wallets.length - 1;
      const instructions = [
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
        ...chunkFundIx,
        createIx,
        ...chunkIxs,
      ];
      if (isLast && tipIx) instructions.push(tipIx);

      let sim: Awaited<ReturnType<Connection["simulateTransaction"]>>;
      if (lookupTable) {
        const v0 = buildSandboxV0({
          payerKey: creator.publicKey,
          recentBlockhash: latest.blockhash,
          instructions,
          lookupTable,
          signers: [creator, mintKeypair, wallet],
        });
        sim = await connection.simulateTransaction(v0);
      } else {
        const tx = new Transaction({ feePayer: creator.publicKey, blockhash: latest.blockhash, lastValidBlockHeight: 0 });
        tx.add(...instructions);
        sim = await connection.simulateTransaction(tx, [creator, mintKeypair, wallet]);
      }
      if (sim.value.err) {
        throw new Error(
          `bundle sim: buy tx ${i} wallet ${w} failed: ${JSON.stringify(sim.value.err)}`
        );
      }
      results.push({
        label: `buy${i + 1}[${wallet.publicKey.toBase58().slice(0, 4)}]${isLast && tipIx ? "+tip" : ""}`,
        unitsConsumed: sim.value.unitsConsumed ?? null,
      });
    }
    walletOffset += bt.wallets.length;
  }
  return results;
}
