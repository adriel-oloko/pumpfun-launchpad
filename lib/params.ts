// Single source of truth for every curve and token parameter the client
// needs to quote against pump.fun's NATIVE program (6EF8rrecth...). Values
// are confirmed against the LIVE global account
// (4wTV1YmiEkRvAtNtsSGPtUrqRYQMe5SKy2uB4Jjaxnjf, Sep 2026 read): the
// program's curve runs on 6-decimal raw units, so the token numbers below
// carry the FULL 10^6 scale (virtual reserve 1_073_000_000_000_000, total
// supply 1_000_000_000_000_000). They are NOT the 1_073_000_000-scale
// values of the abandoned custom program (programs/pumpfun, BTE4vd); those
// smaller numbers cost launch fills 6 decimals of magnitude (dust fills).
// The TypeScript client (M2 scripts, M4 UI) must read its numbers from this
// file and never hardcode them.
//
// CLUSTER WARNING (2026-09): the virtual SOL seed is NOT the same on both
// clusters (mainnet 30 SOL, devnet 1 SOL). Live-read `PUMP_GLOBAL` and fall
// back to `virtualSolReserveFallback(network)`; never sum a hardcoded seed.

import type { SolanaNetwork } from "./network";

/** Token decimals, the number of digits after the decimal point on the mint.
 *  Unit: decimal places. Value: 6 (pump.fun reference). */
export const DECIMALS: number = 6;

/** Total token supply cap, the maximum number of raw units that can ever be
 *  minted by this program's buy instruction. Unit: raw token units (smallest
 *  denomination, 10^-6 of a whole token). Value: 1_000_000_000_000_000 (1e15
 *  raw = 1B tokens at DECIMALS=6; live global-account tokenTotalSupply). */
export const TOTAL_SUPPLY: bigint = BigInt(1_000_000_000_000_000);

/** Virtual SOL reserve seeded into the constant-product curve at creation.
 *  Unit: lamports (1 SOL = 1_000_000_000 lamports). Value: 30 SOL.
 *
 *  MAINNET ONLY. Devnet seeds a 1 SOL virtual reserve
 *  (`initial_virtual_sol_reserves = 1000000000` on the live global account).
 *  Anything that quotes against a hardcoded curve seed must go through
 *  `virtualSolReserveFallback(network)`, never this constant directly. */
export const VIRTUAL_SOL_RESERVE: bigint = BigInt(30_000_000_000);

/** Devnet's virtual SOL seed (live global-account read: 1_000_000_000). */
export const VIRTUAL_SOL_RESERVE_DEVNET: bigint = BigInt(1_000_000_000);

/** Cluster-keyed fallback for the curve's virtual SOL seed, used only when
 *  the live `PUMP_GLOBAL` read fails. Mainnet seeds 30 SOL, devnet 1 SOL; the
 *  virtual TOKEN reserve is identical on both clusters. */
export function virtualSolReserveFallback(
  network: SolanaNetwork
): bigint {
  return network === "mainnet"
    ? VIRTUAL_SOL_RESERVE
    : VIRTUAL_SOL_RESERVE_DEVNET;
}

/** Virtual token reserve seeded into the constant-product curve at creation.
 *  Unit: raw token units. Value: 1_073_000_000_000_000 (1.073B tokens at
 *  DECIMALS=6, live global-account initialVirtualTokenReserves; slightly
 *  above TOTAL_SUPPLY, the surplus raw units exist only as virtual state). */
export const VIRTUAL_TOKEN_RESERVE: bigint = BigInt(1_073_000_000_000_000);

/** Protocol fee charged on the input side of every buy and sell.
 *  Unit: basis points (1% = 100 bps, 100% = 10_000 bps). Value: 100 (1%). */
export const FEE_BPS: bigint = BigInt(100);

/** Slippage band (basis points) the CURVE BUY carries: the floor on the tokens
 *  received (`buy_exact_sol_in`'s `min_tokens_out`). Unit: basis points. Value:
 *  2000 (20%). See CURVE_SELL_SLIPPAGE_BPS for the other side of a trade. */
export const CURVE_BUY_SLIPPAGE_BPS: bigint = BigInt(2000);

/** Slippage band (basis points) the CURVE SELL carries: `min_sol_output` sits
 *  this far below the net quote. Unit: basis points. Value: 10000 (100%),
 *  i.e. the floor is ZERO: the operator's explicit choice, it means a curve
 *  sell never reverts on price (an exit cannot be blocked by the curve moving).
 *  The trade-off is on-chain: at a 0 floor there is no protection against a
 *  sandwich/adverse fill, so the sell always fills at whatever the curve pays
 *  at landing time. 10000 = 0 is the ONLY value that removes that protection;
 *  anything below it still refuses a collapsed fill. */
export const CURVE_SELL_SLIPPAGE_BPS: bigint = BigInt(10_000);

/** SOL dust threshold that gates managed-wallet deletion: a wallet whose SOL
 *  balance is below this is treated as empty and can be removed (per-row x or
 *  batch delete). Mirrors v4's 0.0001 ETH dust floor. Unit: lamports. Value:
 *  100_000 (0.0001 SOL). */
export const DUST_SOL_LAMPORTS: bigint = BigInt(100_000);

/** Flat SOL a wallet KEEPS after a MAX buy (manual Buy Max + launch dev
 *  wallet pre-fill). The max buy spends the wallet's TOTAL balance minus this
 *  fixed keep (and the mechanical ATA-rent/base-fee costs the tx itself needs
 *  to land): no rent-floor reserve, no fee margin, no slippage-band discount.
 *  Wallet with 0.1 SOL ends at 0.002 SOL after the buy. 0.002 > the 890,880
 *  lamport rent-exempt floor, so the wallet stays open. Unit: lamports. Value:
 *  2_000_000 (0.002 SOL). */
export const MAX_BUY_KEEP_SOL_LAMPORTS: bigint = BigInt(2_000_000);
