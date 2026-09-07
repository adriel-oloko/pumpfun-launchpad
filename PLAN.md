# PLAN: Helius Sender SWQOS-only for buy/sell/auto/launch

## Goal
Submit every buy, sell, auto-buy, auto-sell, and (Tier-1) launch tx through
`https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true` with a flat
**5,000-lamport (0.000005 SOL)** tip, while **keeping the priority fee** on every tx
(launch txs already carry one; trade txs get one prepended) and **keeping devnet on
plain RPC**. Do NOT touch `DEFAULT_JITO_TIP_LAMPORTS` (lib/fees.ts), pump.fun tx
construction (lib/pump.ts), relay/Jito-bundle code, or UI layout.

## Files + exact changes

### 1. `lib/bundle/protected-send.ts` (one sender covers manual buy/sell + auto buy/sell)
- `HELIUS_SENDER_URL` → `https://sender.helius-rpc.com/fast?swqos_only=true&mev-protect=true`.
- Replace the 1_000_000-lamport "Sender Max minimum" constant with a flat 5_000
  (`HELIUS_SENDER_SWQOS_TIP_LAMPORTS = 5_000`).
- `protectedTipLamports()`: return flat 5_000 on mainnet (0 devnet) — REMOVE the
  `Math.max(..., DEFAULT_JITO_TIP_LAMPORTS)` clamp.
- `sendProtectedTx()`: tip = `opts.tipLamports ?? 5_000` — REMOVE the clamp.
  Add `skipPriorityFeeIx?: boolean` option (default false → trade path unchanged);
  when true (launch path) do NOT prepend a second `setComputeUnitPrice` ix because
  launch txs already carry one. Devnet branch unchanged.
- Drop the now-unused `DEFAULT_JITO_TIP_LAMPORTS` import; update Sender Max/0.001 SOL
  comments → SWQOS-only / 0.000005.

### 2. `lib/bundle/launch.ts` (launch sequence sender)
- Import `sendProtectedTx` from `./protected-send` (function-body-only references on
  both sides of the resulting module cycle — safe in webpack/Turbopack and tsc-CJS).
- `sendSequentially()`: replace the per-tx `sendAndConfirmWithRetry(...)` call with
  `sendProtectedTx(connection, tx, signers, { attempts: 3, confirmTimeoutMs, label,
  skipPriorityFeeIx: true })`. On mainnet each launch tx (fund/create/buys) is then
  submitted to the SWQOS endpoint with its own 5,000-lamport tip (LAST ix) and its own
  existing priority fee; on devnet `sendProtectedTx` falls through to the same
  `sendAndConfirmWithRetry` plain-RPC path — behavior unchanged.
- Update comments (tip reserve constants note that every mainnet-launch buy tx now
  carries a Sender tip, not just the last relay-bundle tx).

### 3. `components/launch-panel.tsx`
- Remove the Tier-1 `maxBuyTxBytes: 1222 / tipReserveBytes: 0` override so buy txs are
  always packed with the default 1150-byte budget + 90-byte tip reserve (each mainnet
  launch buy tx now carries its own ~90-byte tip transfer). Devnet is unaffected
  functionally (plain RPC still; packing is just conservative).
- Update the Tier-1 description comments/log line (sender on mainnet vs plain RPC on
  devnet).

## Verification
- `npm run lint` and `npm run build` pass.
- `npx tsc -p tsconfig.build.json` still compiles (CLI scripts depend on it).
- Manual/read-only checks: no `Math.max(..., DEFAULT_JITO_TIP_LAMPORTS)` clamp remains
  on the protected tip; no second priority-fee ix added for launch txs.
