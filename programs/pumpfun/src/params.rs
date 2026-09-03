//! Single source of truth for every curve and token parameter.
//!
//! This is the one and only place the curve is tuned. Every instruction reads
//! its numbers from these `pub const`s; no other code in this crate may
//! hardcode a magic number. A mirror of this file lives at `lib/params.ts`
//! (same names, units, values, doc comments) so the TypeScript client reads
//! identical numbers. Keep the two files in sync by hand; drift should be
//! treated as a bug and fixed in both places.
//!
//! Values are pump.fun's public reference numbers, treated as confirm-with-user
//! defaults, not gospel.

/// Token decimals, the number of digits after the decimal point on the mint.
/// Unit: decimal places. Value: 6 (pump.fun reference).
pub const DECIMALS: u8 = 6;

/// Total token supply cap, the maximum number of raw units that can ever be
/// minted by this program's buy instruction. Unit: raw token units (smallest
/// denomination, no on-chain decimals). Value: 1_000_000_000.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000;

/// Virtual SOL reserve seeded into the constant-product curve at creation.
/// Unit: lamports (1 SOL = 1_000_000_000 lamports). Value: 30 SOL.
pub const VIRTUAL_SOL_RESERVE: u64 = 30_000_000_000;

/// Virtual token reserve seeded into the constant-product curve at creation.
/// Unit: raw token units. Value: 1_073_000_000 (pump.fun reference, slightly
/// above TOTAL_SUPPLY; the surplus raw units exist only as virtual state).
pub const VIRTUAL_TOKEN_RESERVE: u64 = 1_073_000_000;

/// Protocol fee charged on the input side of every buy and sell.
/// Unit: basis points (1% = 100 bps, 100% = 10_000 bps). Value: 100 (1%).
pub const FEE_BPS: u64 = 100;

/// Curve graduation threshold: the total SOL reserve (virtual 30 SOL plus real
/// buy proceeds) at which the curve is considered filled. Unit: lamports.
/// Value: 85 SOL, which is the 30 virtual SOL plus roughly 55 real SOL, the
/// point where pump.fun reclaims the virtual reserve and graduates.
pub const GRADUATION_THRESHOLD_SOL: u64 = 85_000_000_000;

/// Default for the per-token auto-migration option, pre-filled into the launch
/// dashboard and stored on the curve at create() time. When true, the buy that
/// fills the curve graduates it in the same instruction; when false, the
/// recorded creator calls the graduate instruction manually. The program
/// itself never reads these defaults: create() takes the flags as arguments,
/// and the dashboard pre-fills from them (mirrored in lib/params.ts).
#[allow(dead_code)]
pub const DEFAULT_AUTO_MIGRATE: bool = true;

/// Default for the per-token LP-lock option, pre-filled into the launch
/// dashboard and stored on the curve at create() time. When true, the client
/// migration script burns the LP minted by the PumpSwap createPool call; when
/// false, the LP stays under the creator (they can remove liquidity later).
#[allow(dead_code)]
pub const DEFAULT_LOCK_LP: bool = true;
