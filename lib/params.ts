// Single source of truth for every curve and token parameter, mirroring
// programs/pumpfun/src/params.rs (same names, units, values, doc comments).
// The TypeScript client (M2 scripts, M4 UI) must read its numbers from this
// file and never hardcode them. Keep the two files in sync by hand; drift
// should be treated as a bug and fixed in both places.
//
// Values are pump.fun's public reference numbers, treated as confirm-with-user
// defaults, not gospel.

/** Token decimals, the number of digits after the decimal point on the mint.
 *  Unit: decimal places. Value: 6 (pump.fun reference). */
export const DECIMALS: number = 6;

/** Total token supply cap, the maximum number of raw units that can ever be
 *  minted by this program's buy instruction. Unit: raw token units (smallest
 *  denomination, no on-chain decimals). Value: 1_000_000_000. */
export const TOTAL_SUPPLY: bigint = BigInt(1_000_000_000);

/** Virtual SOL reserve seeded into the constant-product curve at creation.
 *  Unit: lamports (1 SOL = 1_000_000_000 lamports). Value: 30 SOL. */
export const VIRTUAL_SOL_RESERVE: bigint = BigInt(30_000_000_000);

/** Virtual token reserve seeded into the constant-product curve at creation.
 *  Unit: raw token units. Value: 1_073_000_000 (pump.fun reference, slightly
 *  above TOTAL_SUPPLY; the surplus raw units exist only as virtual state). */
export const VIRTUAL_TOKEN_RESERVE: bigint = BigInt(1_073_000_000);

/** Protocol fee charged on the input side of every buy and sell.
 *  Unit: basis points (1% = 100 bps, 100% = 10_000 bps). Value: 100 (1%). */
export const FEE_BPS: bigint = BigInt(100);

/** Curve graduation threshold: the total SOL reserve (virtual 30 SOL plus real
 *  buy proceeds) at which the curve is considered filled. Unit: lamports.
 *  Value: 85 SOL, which is the 30 virtual SOL plus roughly 55 real SOL, the
 *  point where pump.fun reclaims the virtual reserve and graduates. */
export const GRADUATION_THRESHOLD_SOL: bigint = BigInt(85_000_000_000);

/** Default for the per-token auto-migration option, pre-filled into the launch
 *  dashboard and stored on the curve at create() time. When true, the buy that
 *  fills the curve graduates it in the same instruction; when false, the
 *  recorded creator calls the graduate instruction manually. */
export const DEFAULT_AUTO_MIGRATE: boolean = true;

/** Default for the per-token LP-lock option, pre-filled into the launch
 *  dashboard and stored on the curve at create() time. When true, the client
 *  migration script burns the LP minted by the PumpSwap createPool call; when
 *  false, the LP stays under the creator (they can remove liquidity later). */
export const DEFAULT_LOCK_LP: boolean = true;

/** SOL dust threshold that gates managed-wallet deletion: a wallet whose SOL
 *  balance is below this is treated as empty and can be removed (per-row x or
 *  batch delete). Mirrors v4's 0.0001 ETH dust floor. Unit: lamports. Value:
 *  100_000 (0.0001 SOL). */
export const DUST_SOL_LAMPORTS: bigint = BigInt(100_000);
