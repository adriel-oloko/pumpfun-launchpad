"use client";

// Milestone M4-UI-MATCH: the board page, restructured to v4-launchpad's
// exact two-column layout. Masthead on top; LaunchPanel (left) + TradePanel
// (right) in a `flex flex-col lg:flex-row gap-6` row under the v4 page
// padding. The roster state is shared: the launch panel reads the checked
// dev wallets and sets the tracked mint; the trade panel hosts the roster
// and its token-address input selects the curve mint (a LAUNCH pre-fills
// it, mirroring v4's launch -> trade flow).

import { useState } from "react";
import { LaunchPanel } from "../components/launch-panel";
import { Masthead } from "../components/masthead";
import { useRoster } from "../components/roster";
import { TradePanel } from "../components/trade-panel";
import { isValidPubkey } from "../lib/managed-wallets";

export default function Board() {
  const roster = useRoster();

  // Single source of truth for the mint selected in the Trade panel; the
  // roster token column tracks it (the launch panel pre-fills it after a
  // successful launch, exactly like v4's trade-token pre-fill).
  const [tradeToken, setTradeToken] = useState("");

  const handleTokenAddrChange = (v: string) => {
    setTradeToken(v);
    const trimmed = v.trim();
    roster.setTrackedMint(isValidPubkey(trimmed) ? trimmed : null);
  };

  const handleLaunched = (mint: string) => {
    setTradeToken(mint);
    roster.setTrackedMint(mint);
  };

  return (
    <main className="mx-auto w-full px-7 py-7">
      <Masthead />

      <div className="mt-6 flex flex-col lg:flex-row gap-6">
        <LaunchPanel roster={roster} onLaunched={handleLaunched} />
        <TradePanel
          api={roster}
          tokenAddr={tradeToken}
          onTokenAddrChange={handleTokenAddrChange}
        />
      </div>
    </main>
  );
}
