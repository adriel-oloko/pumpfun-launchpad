// Milestone M8C (2026-09-03): the Distribute tab SOL-operation engines,
// ported from v4-launchpad's disperse/withdraw/delete-managed-wallets
// (EVM -> Solana).
//
//   - Disperse: ONE hub-signed transaction carrying one
//     SystemProgram.transfer per recipient, a random lamport amount in
//     [min, max] each (crypto.getRandomValues, never Math.random:
//     predictable amounts defeat the obfuscation purpose). Solana has no
//     msg.value and no auto-refund, so the tx transfers exactly
//     sum(amounts), the hub signs once, and the hub's own ~5000-lamport
//     fee comes out of the hub: sufficiency is checked against
//     sum(amounts) + fee. Recipients are SELECTED ADDRESSES (a receiver
//     needs no key).
//   - Withdraw: every selected KEYED wallet (the destination itself is
//     never a source) sends its spendable SOL to the destination in its
//     OWN signed transfer tx, fired concurrently with Promise.allSettled
//     (a public-mempool sweep, NOT one atomic bundle). SOLANA-CORRECT
//     DRAIN: a writable system account cannot end a tx with a non-zero
//     balance below the 890,880-lamport rent floor (the runtime rejects
//     InsufficientFundsForRent). v4 sweeps to ~0 because ETH has no rent;
//     the Solana sweep sends balance - RENT_EXEMPT_FLOOR - fee reserve and
//     each wallet keeps the rent floor (~0.00089 SOL) plus the reserve.
//   - Delete: a pure selection helper over the roster balance map. Token
//     balance does NOT gate deletion (user spec): a wallet with tokens but
//     no SOL is still removable. Unknown balances are never deleted.
//
// All amounts are bigint (no bigint literals, project target is ES2017).
// Sends go through lib/bundle/launch.ts's sendAndConfirmWithRetry
// (expiry-safe re-sends only, never a blind double-fire). The hub is the
// FIRST roster wallet; callers pass it explicitly.

import bs58 from "bs58";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";
import {
  RENT_EXEMPT_FLOOR,
  sendAndConfirmWithRetry,
} from "./bundle/launch";

/** Lamports a swept wallet keeps beyond the rent floor to pay its
 *  transfer's ~5000-lamport base fee with a small margin. Module constant
 *  (M8C spec). Unit: lamports. Value: 10_000. */
export const WITHDRAW_FEE_RESERVE_LAMPORTS: bigint = BigInt(10_000);

/** Uniform random integer in [min, max] INCLUSIVE. 256 bits of entropy via
 *  crypto.getRandomValues, folded onto the range with a modulo (returns min
 *  when max <= min). crypto, never Math.random: predictable disperse
 *  amounts defeat the obfuscation purpose. */
export function randomLamportsBetween(min: bigint, max: bigint): bigint {
  if (max <= min) return min;
  const range = max - min;
  const buf = new Uint32Array(8);
  crypto.getRandomValues(buf);
  let r = BigInt(0);
  for (let i = 0; i < buf.length; i++) {
    r = (r << BigInt(32)) | BigInt(buf[i]);
  }
  return min + (r % (range + BigInt(1)));
}

/** The hub: the FIRST roster wallet, base58 address + secret key. */
export interface DisperseHub {
  address: string;
  /** Base58 64-byte secret of the hub (disperse requires the hub to sign). */
  key: string;
}

export interface DisperseOptions {
  connection: Connection;
  hub: DisperseHub;
  /** Recipient addresses (base58, case-sensitive). Receivers need NO key. */
  recipients: string[];
  minLamports: bigint;
  maxLamports: bigint;
}

export interface DisperseResult {
  /** Confirmed signature of the single disperse tx. */
  signature: string;
  /** Sum of the random per-recipient amounts actually sent (lamports). */
  totalLamports: bigint;
  /** Number of recipients funded. */
  count: number;
}

/** Funds every recipient from the hub in ONE hub-signed tx: one
 *  SystemProgram.transfer per recipient with a random amount in
 *  [minLamports, maxLamports]. Throws a descriptive error when the hub key
 *  is missing/invalid, a recipient address is invalid, the amount is zero,
 *  or the hub balance cannot cover sum(amounts) + the tx fee. */
export async function disperseSol(
  opts: DisperseOptions
): Promise<DisperseResult> {
  const { connection, hub, recipients, minLamports, maxLamports } = opts;
  if (recipients.length === 0) {
    throw new Error("DISPERSER: NO RECIPIENTS (CHECK ROWS IN THE ROSTER)");
  }
  let hubKp: Keypair;
  try {
    hubKp = Keypair.fromSecretKey(bs58.decode(hub.key));
  } catch {
    throw new Error(
      `DISPERSER: HUB HAS NO VALID KEY (RE-ADD THE HUB SECRET IN THE ROSTER): ${hub.address}`
    );
  }
  const recipientPks: PublicKey[] = [];
  for (const address of recipients) {
    try {
      recipientPks.push(new PublicKey(address));
    } catch {
      throw new Error(`DISPERSER: INVALID RECIPIENT ADDRESS ${address}`);
    }
  }
  const amounts = recipients.map(() =>
    randomLamportsBetween(minLamports, maxLamports)
  );
  let total = BigInt(0);
  for (const amount of amounts) total += amount;
  if (total <= BigInt(0)) {
    throw new Error("DISPERSER: AMOUNT IS 0 (RAISE MIN/MAX ABOVE ZERO)");
  }
  // One signature = one ~5000-lamport base fee, paid from the hub (Solana
  // has no auto-refund, so the tx moves exactly sum(amounts)).
  const feeLamports = BigInt(5_000);
  const live = BigInt(
    await connection.getBalance(hubKp.publicKey, "confirmed")
  );
  if (live < total + feeLamports) {
    throw new Error(
      `DISPERSER: HUB BALANCE ${live} LAMPORTS IS BELOW ${total} (SUM) + FEE (INSUFFICIENT FUNDS)`
    );
  }
  const tx = new Transaction({ feePayer: hubKp.publicKey });
  for (let i = 0; i < recipientPks.length; i++) {
    tx.add(
      SystemProgram.transfer({
        fromPubkey: hubKp.publicKey,
        toPubkey: recipientPks[i],
        lamports: Number(amounts[i]),
      })
    );
  }
  const { signature } = await sendAndConfirmWithRetry(connection, tx, [hubKp], {
    attempts: 2,
    confirmTimeoutMs: 45_000,
    label: "disperse",
  });
  return { signature, totalLamports: total, count: recipients.length };
}

/** One sweep source: a selected wallet that holds a key and signs its own
 *  transfer. */
export interface WithdrawWallet {
  address: string;
  key: string;
}

export interface WithdrawOptions {
  connection: Connection;
  wallets: WithdrawWallet[];
  /** Base58 destination; never a sweep source itself. */
  dest: string;
  /** Kept behind the rent floor to pay the tx fee (module default 10_000). */
  feeReserveLamports?: bigint;
}

/** Per-wallet sweep outcome. */
export interface WithdrawOutcome {
  address: string;
  /** Lamports actually transferred to the destination (0 when not sent). */
  solWithdrawn: bigint;
  /** Confirmed signature when the tx landed, else null. */
  signature: string | null;
  status: "sent" | "skipped" | "failed";
  /** Short human reason for skipped/failed rows. */
  reason?: string;
}

/** Error text of an unknown thrown value. */
function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** One sweep worker: reads the wallet's LIVE balance, sends
 *  balance - rent floor - fee reserve to the destination in the wallet's
 *  own signed tx. Never transfers below the rent floor (see the drain note
 *  in the file header). */
async function sweepOne(
  connection: Connection,
  wallet: WithdrawWallet,
  destPk: PublicKey,
  feeReserve: bigint,
  rentFloor: bigint
): Promise<WithdrawOutcome> {
  let kp: Keypair;
  try {
    kp = Keypair.fromSecretKey(bs58.decode(wallet.key));
  } catch {
    return {
      address: wallet.address,
      solWithdrawn: BigInt(0),
      signature: null,
      status: "failed",
      reason: "INVALID WALLET KEY",
    };
  }
  let live: number;
  try {
    live = await connection.getBalance(kp.publicKey, "confirmed");
  } catch (e) {
    return {
      address: wallet.address,
      solWithdrawn: BigInt(0),
      signature: null,
      status: "failed",
      reason: errText(e),
    };
  }
  const value = BigInt(live) - rentFloor - feeReserve;
  if (value <= BigInt(0)) {
    return {
      address: wallet.address,
      solWithdrawn: BigInt(0),
      signature: null,
      status: "skipped",
      reason: "BALANCE AT RENT FLOOR",
    };
  }
  const tx = new Transaction({ feePayer: kp.publicKey });
  tx.add(
    SystemProgram.transfer({
      fromPubkey: kp.publicKey,
      toPubkey: destPk,
      lamports: Number(value),
    })
  );
  try {
    const { signature } = await sendAndConfirmWithRetry(
      connection,
      tx,
      [kp],
      {
        attempts: 2,
        confirmTimeoutMs: 45_000,
        label: "withdraw",
      }
    );
    return {
      address: wallet.address,
      solWithdrawn: value,
      signature,
      status: "sent",
    };
  } catch (e) {
    return {
      address: wallet.address,
      solWithdrawn: BigInt(0),
      signature: null,
      status: "failed",
      reason: errText(e),
    };
  }
}

/** Sweeps every selected keyed wallet's spendable SOL to `dest`, one signed
 *  transfer tx per wallet, fired CONCURRENTLY (Promise.allSettled). The
 *  destination address is excluded from the sources (base58 comparison,
 *  case-sensitive). Throws a descriptive error for an invalid destination;
 *  per-wallet build/send failures are reported as failed outcomes, wallets
 *  with nothing above the rent floor + reserve as skipped. */
export async function withdrawSol(
  opts: WithdrawOptions
): Promise<WithdrawOutcome[]> {
  const { connection, dest } = opts;
  const feeReserve = opts.feeReserveLamports ?? WITHDRAW_FEE_RESERVE_LAMPORTS;
  let destPk: PublicKey;
  try {
    destPk = new PublicKey(dest);
  } catch {
    throw new Error("WITHDRAW: INVALID DESTINATION ADDRESS");
  }
  // The destination is never a sweep source.
  const sources = opts.wallets.filter((w) => w.address !== dest);
  if (sources.length === 0) return [];
  const rentFloor = BigInt(RENT_EXEMPT_FLOOR);
  const settled = await Promise.allSettled(
    sources.map((w) => sweepOne(connection, w, destPk, feeReserve, rentFloor))
  );
  return settled.map((r, i) => {
    if (r.status === "fulfilled") return r.value;
    return {
      address: sources[i].address,
      solWithdrawn: BigInt(0),
      signature: null,
      status: "failed" as const,
      reason: errText(r.reason),
    };
  });
}

/** Minimal balance shape the delete gate reads from the roster map. */
export interface SolBalance {
  sol: bigint | null;
}

/** Pure batch-delete selection: every SELECTED address whose SOL balance is
 *  KNOWN and below `dustLamports` is deletable; every other selected
 *  address (funded, or an unknown read) counts as skipped and is never
 *  deleted. Token balance does NOT gate deletion. The roster's own hub
 *  guard (Prompt D) additionally protects the first wallet; callers should
 *  exclude it from `selected`. */
export function deleteEmptyWallets(
  wallets: readonly { address: string }[],
  balances: ReadonlyMap<string, SolBalance>,
  selected: readonly string[],
  dustLamports: bigint
): { toDelete: string[]; skipped: number } {
  const roster = new Set(wallets.map((w) => w.address));
  const toDelete: string[] = [];
  let skipped = 0;
  for (const address of selected) {
    if (!roster.has(address)) continue;
    const sol = balances.get(address)?.sol ?? null;
    if (sol !== null && sol < dustLamports) {
      toDelete.push(address);
    } else {
      skipped += 1;
    }
  }
  return { toDelete, skipped };
}
