# v4-launchpad "Trade For Managed Wallets" vs pumpfun-launchpad — gap inventory

Basis: v4-launchpad `components/trade-panel.tsx` (managed-wallet section from ~line 2967, logic at 1412-1700 and 1914+) vs pumpfun-launchpad `components/trade-panel.tsx` + `components/roster.tsx` as it stands today (M4 UI-match + M5 auto engine + M6 sell-all landed, M7 pending).

Here is what v4 exposes, and what is NOT available on pumpfun-launchpad.

## V4 "Trade For Managed Wallets" inventory, by area

### A. Buy/Sell tab (the manual batch trade tab, default tab in v4)
- A1. batch-size input (selectCount, sets how many rows a checkbox click toggles)
- A2. Buy % input + "Buy N%" button -> one atomic Flashbots bundle, buys for every SELECTED keyed wallet
- A3. Sell % input + "Sell N%" button -> one atomic Flashbots bundle, sells per selected keyed wallet
- A4. keyboard shortcuts: b/B buy, s/S sell (Buy/Sell tab only), d/D deselect all (anywhere)

### B. Auto tab (live scheduler in v4 HEAD)
- B1. Auto Buy checkbox, MIN ETH, WALLET COUNT, DURATION, countdown readout
- B2. Auto Sell checkbox, MIN %, WALLET COUNT, DURATION, countdown readout
- B3. Start / Stop + status line
  - note: v4's auto-sell MIN % field is UI-only there, never wired

### C. Distribute tab
- C1. private-key paste input + Add button (Enter also adds)
- C2. Random wallet count input + Random button (generates fresh keys, up to 1000/click)
- C3. on Add AND Random: auto PK-backup download of every keyed key to a timestamped pk.json
- C4. Disperse MIN / MAX + "Disperse X-Y ETH" button (hub's ETH fanned out to selected wallets, one atomic UniversalRouter Flashbots tx)
- C5. Withdraw button -> modal (destination default = first wallet) -> public-mempool sweep of selected wallets to that address
- C6. Delete button (batch-removes selected wallets whose ETH == 0; skips the rest with a report)
- C7. "VIA <addr> — DISPERSER · WITHDRAW DEFAULT DEST" notice

### D. Roster table (shared, below tabs)
- D1. select-all checkbox (toggleAll over selectable wallets)
- D2. HUB row: first wallet never selectable, muted HUB marker
- D3. per-row checkbox (batch anchored at clicked row)
- D4. address click-to-copy
- D5. ETH column + header shows Σ TOTAL ETH across ALL wallets incl. hub
- D6. Token column showing balance AND live ETH value of holdings at pool price
- D7. Act column: per-row × remove (only when ETH < 0.0001), per-row copy-private-key icon
- D8. "N WALLET(S) WITHOUT KEY SKIPPED", "STALE — LAST-KNOWN-GOOD BALANCES" banners
- D9. batch-op status line + per-wallet tx hashes with explorer links
- D10. watch-only rows after key expiry (address kept, re-key restores)

## Status of each on pumpfun-launchpad

| # | v4 item | Status on pumpfun |
|---|---------|-------------------|
| A1 | batch input | AVAILABLE (different spot: roster tool strip above table, default "2") |
| A2/A3 | Buy/Sell buttons | NOT AVAILABLE (whole Buy/Sell tab deliberately omitted by the M4 spec) |
| A4 | keyboard shortcuts | NOT AVAILABLE (no keydown handler in the pumpfun trade panel) |
| B1/B2/B3 | Auto tab | AVAILABLE (default tab; MIN SOL/MIN %, count, duration, countdown, Start/Stop all present, M5 engine live — MIN % is actually wired here, unlike v4) |
| C1 | Add/import keys | AVAILABLE in a different form (roster "import dev keys" textarea + Import button; no Enter-to-add; lives above the table, not in a Distribute tab) |
| C2 | Random generator | NOT AVAILABLE (no way to mint fresh random keypairs in-app) |
| C3 | PK backup download | NOT AVAILABLE (no export on import/add) |
| C4 | Disperse | NOT AVAILABLE (no distribute/disperse feature at all) |
| C5 | Withdraw modal | NOT AVAILABLE (replaced by Sell All per M4 spec; there is no sweep-ETH-to-address action) |
| C6 | Delete (batch) | NOT AVAILABLE (no way to remove a wallet from the roster from the UI; also no per-row remove, see D7) |
| C7 | VIA/disperser notice | NOT AVAILABLE (no disperser concept) |
| D1 | select-all | AVAILABLE |
| D2 | HUB row | NOT AVAILABLE (no hub concept: in pumpfun every roster row is a plain dev wallet, all selectable) |
| D3 | row batch checkbox | AVAILABLE |
| D4 | copy address | AVAILABLE |
| D5 | Σ header total | NOT AVAILABLE (SOL column header is a plain label) |
| D6 | token valuation | NOT AVAILABLE (token column shows raw balance only; no price conversion) |
| D7 | Act column | NOT AVAILABLE (no per-row remove ×, no copy-private-key; the key column is a read-only "60d"/"watch" label) |
| D8 | skip/stale banners | NOT AVAILABLE (a failed poll silently keeps previous balances) |
| D9 | multi-op status+txs | PARTIAL (Sell All renders its own report with per-wallet sigs; there is no shared batch-status/hash area under the table) |
| D10 | watch-only rows | AVAILABLE at the data layer (expired keys dropped, address kept, "watch" label) |

## Bottom line: what is currently NOT on pumpfun-launchpad

1. Manual multi-wallet Buy and Sell (the entire Buy/Sell tab: % inputs + Buy/Sell buttons). Only the auto bot and sell-all trade; you cannot click one button to buy/sell all currently-selected wallets.
2. Keyboard trading shortcuts (b/s/d).
3. Distribute actions: Disperse (fan hub ETH to selected), Withdraw modal (sweep selected to an address), batch Delete.
4. Random key generation + the automatic PK-backup download that fires on Add/Random.
5. Per-row roster actions: remove-wallet (×) and copy-private-key. Once imported, a key can only be managed by leaving/re-entering it via import.
6. The HUB role (first wallet as disperser source / withdraw default destination, unselectable everywhere).
7. Wallet-value column math (token holdings converted to ETH at pool price) and the Σ total in the balance header.
8. State hygiene UI: "N WITHOUT KEY SKIPPED", "STALE BALANCES", and the shared per-wallet-tx-hash status area.

Two clarifications so the list reads honestly: items 1 and 5's Withdraw slot were deliberate spec decisions on pumpfun (manual Buy/Sell "omitted by spec"; M4-UI-MATCH replaced v4's Withdraw/Remove-LP with Sell All) — so they are "not available by design," whereas items 3 (Disperse/Delete), 4, 5 (row actions), 6, 7, 8 and the keyboard shortcuts are simply not covered by any milestone yet. If you want, I can produce a spec/PROMPT doc for pi covering the missing set, or a narrower one for just the roster/backup hygiene items (Random, pk backup, per-row delete, copy key), which are the most self-contained.
