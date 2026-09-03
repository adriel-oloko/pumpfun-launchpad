//! Virtual constant-product bonding curve, modeled exactly as it will sit
//! inside the Anchor program (Milestone M1). Pure integer math only.
//!
//! # Unit choices
//!
//! - `sol_reserve`: integer lamports, 1 SOL = 1_000_000_000 lamports. It holds
//!   the virtual SOL plus the real SOL backing the pool.
//! - `token_reserve`: integer raw token units, the memecoin's smallest
//!   denomination (no decimals on chain).
//! - `supply_out`: cumulative raw token units minted to buyers. It grows on
//!   `buy` and is monotonic: tokens burned back on `sell` are still counted as
//!   ever-minted, so a sell never changes it.
//! - `fee_bps`: protocol fee in basis points, 1% = 100 bps, 100% = 10_000 bps.
//!
//! # Fee direction
//!
//! The protocol fee is charged on the *input* side of every trade, before the
//! constant-product formula runs. A buyer pays the fee in SOL, so
//! `effective = sol_in * (10000 - fee_bps) / 10000` lamports reach the curve;
//! a seller pays the fee in tokens, so `effective` raw tokens reach the curve.
//! The fee portion never enters the reserves and never reduces the output
//! amount after the fact. Integer division on the fee means a dust input can
//! round to an effective amount of zero, which is rejected as `ZeroAmount`.
//!
//! # Curve math
//!
//! The pool keeps the product of the two reserves constant (`x * y = k`):
//!
//! - buy: `token_out = token_reserve * effective / (sol_reserve + effective)`
//! - sell: `sol_out = sol_reserve * effective / (token_reserve + effective)`
//!
//! All arithmetic is `checked_*`; any overflow surfaces as `CurveError::Overflow`
//! and no library code panics.

/// Errors returned by the bonding curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CurveError {
    /// A trade was attempted with a zero amount (including a dust amount that
    /// rounds to zero after the fee).
    ZeroAmount,
    /// The trade would drain the curve, or burn more supply than was minted.
    InsufficientLiquidity,
    /// The trade overflows `u128` arithmetic.
    Overflow,
}

impl core::fmt::Display for CurveError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        let msg = match self {
            CurveError::ZeroAmount => "trade amount is zero",
            CurveError::InsufficientLiquidity => "insufficient liquidity for trade",
            CurveError::Overflow => "trade overflows u128 arithmetic",
        };
        f.write_str(msg)
    }
}

impl std::error::Error for CurveError {}

/// State of the virtual constant-product bonding curve.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CurveState {
    /// Virtual plus real SOL reserve, integer lamports.
    pub sol_reserve: u128,
    /// Virtual token reserve, integer raw token units.
    pub token_reserve: u128,
    /// Cumulative tokens minted to buyers (monotonic; a sell does not
    /// decrease it, burned tokens are still counted as ever-minted).
    pub supply_out: u128,
    /// Protocol fee in basis points (1% = 100).
    pub fee_bps: u64,
}

impl CurveState {
    /// Applies the protocol fee to an input amount, returning the effective
    /// amount that reaches the curve. The fee is `amount * fee_bps / 10000`,
    /// truncated, so the effective amount is the input minus the fee.
    fn effective(&self, amount: u128) -> Result<u128, CurveError> {
        let keep_bps = 10_000u128
            .checked_sub(self.fee_bps as u128)
            .ok_or(CurveError::Overflow)?;
        amount
            .checked_mul(keep_bps)
            .and_then(|p| p.checked_div(10_000))
            .ok_or(CurveError::Overflow)
    }

    /// Buys tokens with `sol_in` lamports.
    ///
    /// The fee is deducted from `sol_in` first, then tokens are minted at the
    /// constant-product price:
    /// `token_out = token_reserve * effective / (sol_reserve + effective)`.
    /// The effective SOL is added to `sol_reserve`, `token_out` is removed
    /// from `token_reserve`, and `supply_out` (cumulative minted) grows by
    /// `token_out`.
    ///
    /// Errors: `ZeroAmount` for a zero or fee-rounded-to-zero input (or a dust
    /// trade that would mint zero tokens), `Overflow` for any `u128` overflow.
    pub fn buy(&mut self, sol_in: u128) -> Result<u128, CurveError> {
        if sol_in == 0 {
            return Err(CurveError::ZeroAmount);
        }
        let effective = self.effective(sol_in)?;
        if effective == 0 {
            return Err(CurveError::ZeroAmount);
        }
        let new_sol = self
            .sol_reserve
            .checked_add(effective)
            .ok_or(CurveError::Overflow)?;
        // token_out = token_reserve * effective / (sol_reserve + effective)
        let numerator = self
            .token_reserve
            .checked_mul(effective)
            .ok_or(CurveError::Overflow)?;
        let token_out = numerator / new_sol;
        if token_out == 0 {
            return Err(CurveError::ZeroAmount);
        }
        let new_token = self
            .token_reserve
            .checked_sub(token_out)
            .ok_or(CurveError::Overflow)?;
        self.supply_out = self
            .supply_out
            .checked_add(token_out)
            .ok_or(CurveError::Overflow)?;
        self.sol_reserve = new_sol;
        self.token_reserve = new_token;
        Ok(token_out)
    }

    /// Sells `token_in` raw tokens for lamports.
    ///
    /// The fee is deducted from `token_in` first, then SOL is paid out at the
    /// constant-product price:
    /// `sol_out = sol_reserve * effective / (token_reserve + effective)`.
    /// The effective tokens are added to `token_reserve` and `sol_out` is
    /// removed from `sol_reserve`. `supply_out` is cumulative minted, so a
    /// sell leaves it unchanged.
    ///
    /// Errors: `ZeroAmount` for zero or fee-rounded-to-zero input,
    /// `InsufficientLiquidity` when the effective amount would drain the token
    /// reserve (`effective >= token_reserve`), `Overflow` for any `u128`
    /// overflow.
    pub fn sell(&mut self, token_in: u128) -> Result<u128, CurveError> {
        if token_in == 0 {
            return Err(CurveError::ZeroAmount);
        }
        let effective = self.effective(token_in)?;
        if effective == 0 {
            return Err(CurveError::ZeroAmount);
        }
        // Selling all effective tokens would drain the token reserve.
        if effective >= self.token_reserve {
            return Err(CurveError::InsufficientLiquidity);
        }
        let new_token = self
            .token_reserve
            .checked_add(effective)
            .ok_or(CurveError::Overflow)?;
        // sol_out = sol_reserve * effective / (token_reserve + effective)
        let numerator = self
            .sol_reserve
            .checked_mul(effective)
            .ok_or(CurveError::Overflow)?;
        let sol_out = numerator / new_token;
        let new_sol = self
            .sol_reserve
            .checked_sub(sol_out)
            .ok_or(CurveError::Overflow)?;
        self.sol_reserve = new_sol;
        self.token_reserve = new_token;
        Ok(sol_out)
    }

    /// Marginal price in lamports per raw token: `sol_reserve / token_reserve`
    /// with integer (truncating) division.
    ///
    /// Precision loss: the fractional lamport per token is dropped, so the
    /// reported price understates the true ratio by up to one lamport per
    /// token, and reports 0 while the ratio is below one lamport per token.
    /// All curve operations keep `token_reserve >= 1`, so the division never
    /// panics in normal use; for the degenerate zero-reserve state the price
    /// is reported as `u128::MAX`.
    pub fn price(&self) -> u128 {
        match self.token_reserve {
            0 => u128::MAX,
            t => self.sol_reserve / t,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Fresh curve: 30 SOL virtual reserve, 1B raw token virtual reserve,
    /// 1% protocol fee.
    fn curve(fee_bps: u64) -> CurveState {
        CurveState {
            sol_reserve: 30_000_000_000,
            token_reserve: 1_000_000_000,
            supply_out: 0,
            fee_bps,
        }
    }

    #[test]
    fn known_value_buy_with_fee() {
        let mut c = curve(100); // 1% fee
        let sol_in = 1_000_000_000; // 1 SOL
        let out = c.buy(sol_in).unwrap();
        // effective = 1e9 * 9900 / 10000 = 990_000_000
        // token_out = 1e9 * 990_000_000 / (30e9 + 990_000_000) = 31_945_788
        assert_eq!(out, 31_945_788);
        assert_eq!(c.sol_reserve, 30_990_000_000);
        assert_eq!(c.token_reserve, 968_054_212);
        assert_eq!(c.supply_out, 31_945_788);
    }

    #[test]
    fn known_value_buy_zero_fee() {
        let mut c = curve(0);
        // token_out = 1e9 * 1e9 / (30e9 + 1e9) = 32_258_064 (exact x*y=k)
        let out = c.buy(1_000_000_000).unwrap();
        assert_eq!(out, 32_258_064);
        assert_eq!(c.sol_reserve, 31_000_000_000);
        assert_eq!(c.token_reserve, 967_741_936);
    }

    #[test]
    fn known_value_sell_with_fee() {
        let mut c = curve(100); // 1% fee
        let token_in = 100_000_000;
        let out = c.sell(token_in).unwrap();
        // effective = 100e6 * 9900 / 10000 = 99_000_000
        // sol_out = 30e9 * 99_000_000 / (1e9 + 99_000_000) = 2_702_456_778
        assert_eq!(out, 2_702_456_778);
        assert_eq!(c.sol_reserve, 30_000_000_000 - 2_702_456_778);
        assert_eq!(c.token_reserve, 1_099_000_000);
        assert_eq!(c.supply_out, 0); // cumulative minted, still zero
    }

    #[test]
    fn price_increases_after_buy() {
        let mut c = curve(100);
        let before = c.price();
        c.buy(1_000_000_000).unwrap();
        let after = c.price();
        // 30e9 / 1e9 = 30 before; 30.99e9 / 968_054_212 = 32 after
        assert_eq!(before, 30);
        assert_eq!(after, 32);
        assert!(after > before);
    }

    #[test]
    fn price_truncates_fractional_lamports() {
        let c = CurveState {
            sol_reserve: 31,
            token_reserve: 2,
            supply_out: 0,
            fee_bps: 0,
        };
        assert_eq!(c.price(), 15); // 15.5 truncates to 15
        let c2 = CurveState {
            sol_reserve: 1,
            token_reserve: 2,
            supply_out: 0,
            fee_bps: 0,
        };
        assert_eq!(c2.price(), 0); // ratio below 1 lamport per token reports 0
    }

    #[test]
    fn sell_after_buy_round_trip_loses_only_fee_and_rounding() {
        let mut c = curve(100);
        let sol_in = 1_000_000_000;
        let tokens = c.buy(sol_in).unwrap();
        let sol_back = c.sell(tokens).unwrap();
        // The 1% fee plus integer rounding make the payout strictly less.
        assert!(sol_back < sol_in);
        assert_eq!(sol_back, 980_413_167);
        // Reserves return close to the original state.
        assert_eq!(c.sol_reserve, 30_009_586_833);
        assert_eq!(c.token_reserve, 999_680_542);
        // Cumulative minted is untouched by the sell (monotonic).
        assert_eq!(c.supply_out, 31_945_788);
    }

    #[test]
    fn zero_input_rejected() {
        let mut c = curve(100);
        assert_eq!(c.buy(0), Err(CurveError::ZeroAmount));
        assert_eq!(c.sell(0), Err(CurveError::ZeroAmount));
    }

    #[test]
    fn dust_input_rounds_to_zero_effective_and_is_rejected() {
        // fee_bps = 5000 means 50% fee: 1 lamport of input rounds to 0 effective.
        let mut c = curve(5000);
        assert_eq!(c.buy(1), Err(CurveError::ZeroAmount));
        assert_eq!(c.sell(1), Err(CurveError::ZeroAmount));
    }

    #[test]
    fn huge_input_returns_overflow_not_panic() {
        let mut c = curve(100);
        // u128::MAX * 9900 overflows u128: must be an Err, never a panic.
        assert_eq!(c.buy(u128::MAX), Err(CurveError::Overflow));
        assert_eq!(c.sell(u128::MAX), Err(CurveError::Overflow));
        // A very large but fee-safe buy also overflows the product.
        assert_eq!(c.buy(1_000_000_000_000_000_000_000_000_000_000_000_000),
                   Err(CurveError::Overflow));
        // State is untouched by rejected trades.
        assert_eq!(c.sol_reserve, 30_000_000_000);
        assert_eq!(c.token_reserve, 1_000_000_000);
    }

    #[test]
    fn sell_that_would_drain_the_curve_is_rejected() {
        let mut c = curve(100);
        // effective = 1_100_000_000 * 9900 / 10000 = 1_089_000_000 >= 1e9.
        assert_eq!(c.sell(1_100_000_000), Err(CurveError::InsufficientLiquidity));
        // Even a full-reserve sell with zero fee is rejected.
        let mut c0 = curve(0);
        assert_eq!(c0.sell(1_000_000_000), Err(CurveError::InsufficientLiquidity));
    }

    #[test]
    fn fee_accounting_is_exact() {
        // fee_bps = 100 means the fee is exactly 1% of the input, truncated.
        let mut c = curve(100);
        let sol_in = 1_000_000_000;
        c.buy(sol_in).unwrap();
        // Only the effective 990_000_000 lamports enter the reserve.
        assert_eq!(c.sol_reserve, 30_000_000_000 + 990_000_000);
        // Same check on the sell side: 1% of tokens is retained as fee.
        let mut c2 = curve(100);
        c2.sell(100_000_000).unwrap();
        assert_eq!(c2.token_reserve, 1_000_000_000 + 99_000_000);
    }
}
