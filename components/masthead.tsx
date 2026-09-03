"use client";

// Masthead: the big title plate and the shared creator-key connect flow.
// Mirrors v4-launchpad's masthead one-for-one, adapted from the EVM hex
// private-key input to a Solana base58 64-byte secret input. The connected
// creator is the SAME wallet the launch panel signs with (one shared
// CreatorWalletProvider reading pumpfun.creatorKey.v1).

import { useState } from "react";
import { useCreatorWallet } from "../lib/creator-wallet";
import { shortAddress } from "../lib/format";
import { isSolanaSecretKey } from "../lib/managed-wallets";
import { Btn, Input } from "./ui";

export function Masthead() {
  const { connected, pubkey, balanceSol, connectKey, disconnect } =
    useCreatorWallet();

  const [pkOpen, setPkOpen] = useState(false);
  const [pkKey, setPkKey] = useState("");
  const [pkError, setPkError] = useState<string | null>(null);

  const pkValid = isSolanaSecretKey(pkKey);

  function handlePkConnect() {
    if (!pkValid) return;
    setPkError(null);
    try {
      connectKey(pkKey);
      setPkKey("");
      setPkOpen(false);
    } catch (e) {
      setPkError(e instanceof Error ? e.message : String(e));
    }
  }

  return (
    <header className="masthead">
      {/* title block */}
      <div className="px-[14px] py-[18px]">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-[30px] font-bold leading-[1.05] tracking-[1px] uppercase max-sm:text-[22px]">
              Pumpfun Launchpad
            </h1>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {!connected ? (
              <>
                <Btn
                  onClick={() => setPkOpen((v) => !v)}>
                  Connect Key
                </Btn>
                {pkOpen ? (
                  <div className="flex flex-wrap items-center gap-2 w-full">
                    <Input
                      type="password"
                      autoComplete="off"
                      spellCheck={false}
                      value={pkKey}
                      onChange={(e) => {
                        setPkKey(e.target.value);
                        setPkError(null);
                      }}
                      placeholder="BASE58... (SECRET KEY)"
                      className="font-mono text-[12px] w-[280px] max-sm:w-full"
                      onKeyDown={(e) => {
                        if (e.key === "Enter") handlePkConnect();
                      }}
                    />
                    <Btn
                      onClick={handlePkConnect}
                      disabled={!pkValid}>
                      Connect
                    </Btn>
                  </div>
                ) : null}
                {pkError ? (
                  <span className="label-mono text-[10px] font-bold">
                    {pkError}
                  </span>
                ) : null}
              </>
            ) : (
              <>
                <span className="label-mono text-[11px] border-2 border-ink px-2 py-2">
                  {pubkey ? shortAddress(pubkey, 6) : ""} · {balanceSol}
                </span>
                <Btn invert onClick={() => disconnect()}>
                  Disconnect
                </Btn>
              </>
            )}
          </div>
        </div>
      </div>
    </header>
  );
}
