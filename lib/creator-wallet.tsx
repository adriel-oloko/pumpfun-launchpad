"use client";

// The shared creator wallet for the pumpfun launchpad.
//
// ONE wallet connects the whole board: the masthead's "Connect Key" flow
// and the launch panel's creator are the same keypair. The base58 64-byte
// secret is persisted under pumpfun.creatorKey.v1 (the exact key the M4
// launch panel used before the masthead existed), so a previously stored
// creator auto-connects on load and the launch flow keeps working
// unchanged. Balance is polled on the rotating devnet RPC pool while a key
// is connected so the masthead pill stays live across launches (a launch
// spends creator SOL funding the dev wallets).

import { LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { makeDevnetConnection } from "./connection";
import { pubkeyFromSecretKey } from "./managed-wallets";

/** The localStorage key the launch panel persisted the creator key under. */
export const CREATOR_KEY_STORAGE = "pumpfun.creatorKey.v1";
const BALANCE_POLL_MS = 5_000;

export interface CreatorWalletState {
  /** True when a valid creator key is connected. */
  connected: boolean;
  /** The connected base58 64-byte secret (empty when not connected). */
  key: string;
  /** Derived base58 pubkey of the connected creator (null when none). */
  pubkey: string | null;
  /** Creator balance in lamports; null while unknown / read failed. */
  balanceLamports: bigint | null;
  /** Formatted "X.XXXX SOL" for the masthead pill ("--" when unknown). */
  balanceSol: string;
  /** Connect a base58 secret. Throws when the key is not a valid 64-byte
   *  Solana secret. */
  connectKey: (secret: string) => void;
  /** Forget the connected key (localStorage cleared). */
  disconnect: () => void;
}

const CreatorWalletContext = createContext<CreatorWalletState | null>(null);

export function CreatorWalletProvider({ children }: { children: ReactNode }) {
  const [key, setKey] = useState("");
  const [balanceLamports, setBalanceLamports] = useState<bigint | null>(null);

  const pubkey = useMemo(() => (key ? pubkeyFromSecretKey(key) : null), [key]);

  // Load the persisted creator key once on mount (single source of truth).
  useEffect(() => {
    if (typeof window === "undefined") return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- localStorage read on mount
    setKey(window.localStorage.getItem(CREATOR_KEY_STORAGE) ?? "");
  }, []);

  // Persist the connected key on change.
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      if (key) window.localStorage.setItem(CREATOR_KEY_STORAGE, key);
      else window.localStorage.removeItem(CREATOR_KEY_STORAGE);
    } catch {
      // storage unavailable; key stays in memory
    }
  }, [key]);

  // Balance poll while a key is connected.
  useEffect(() => {
    if (!pubkey) return;
    let cancelled = false;
    const conn = makeDevnetConnection();
    const read = async () => {
      try {
        const b = await conn.getBalance(new PublicKey(pubkey), "confirmed");
        if (!cancelled) setBalanceLamports(BigInt(b));
      } catch {
        // keep the previous balance on a failed read
      }
    };
    void read();
    const id = setInterval(() => void read(), BALANCE_POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, [pubkey]);

  const connectKey = useCallback((secret: string) => {
    const derived = pubkeyFromSecretKey(secret);
    if (!derived) {
      throw new Error("not a valid base58 64-byte Solana secret");
    }
    setBalanceLamports(null);
    setKey(secret);
  }, []);

  const disconnect = useCallback(() => {
    setBalanceLamports(null);
    setKey("");
  }, []);

  const balanceSol = useMemo(() => {
    if (balanceLamports === null) return "--";
    return `${(Number(balanceLamports) / LAMPORTS_PER_SOL).toFixed(4)} SOL`;
  }, [balanceLamports]);

  const value = useMemo<CreatorWalletState>(
    () => ({
      connected: pubkey !== null,
      key,
      pubkey,
      balanceLamports,
      balanceSol,
      connectKey,
      disconnect,
    }),
    [key, pubkey, balanceLamports, balanceSol, connectKey, disconnect]
  );

  return (
    <CreatorWalletContext.Provider value={value}>
      {children}
    </CreatorWalletContext.Provider>
  );
}

export function useCreatorWallet(): CreatorWalletState {
  const ctx = useContext(CreatorWalletContext);
  if (!ctx) {
    throw new Error("useCreatorWallet must be used inside <CreatorWalletProvider>");
  }
  return ctx;
}
