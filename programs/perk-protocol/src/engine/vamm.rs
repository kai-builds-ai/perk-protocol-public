/// Virtual AMM Engine — constant product x*y=k with peg multiplier
///
/// mark_price = (quote_reserve * peg_multiplier) / base_reserve
///
/// All math uses u128 intermediates with checked arithmetic.

use crate::constants::*;
use crate::errors::PerkError;
use crate::state::Market;
use anchor_lang::prelude::*;

/// Result of a vAMM swap
#[derive(Debug, Clone)]
pub struct SwapResult {
    pub base_amount: u128,
    pub quote_amount: u128,
    pub new_base_reserve: u128,
    pub new_quote_reserve: u128,
    pub execution_price: u128, // scaled by PRICE_SCALE
}

/// Calculate mark price from vAMM state: (quote * peg) / base, scaled by PRICE_SCALE
pub fn calculate_mark_price(market: &Market) -> Result<u64> {
    if market.base_reserve == 0 {
        return Err(PerkError::MathOverflow.into());
    }
    // mark_price = quote_reserve * peg_multiplier / base_reserve
    // All values already in their respective scales
    let numerator = (market.quote_reserve as u128)
        .checked_mul(market.peg_multiplier)
        .ok_or(PerkError::MathOverflow)?;
    let price = numerator
        .checked_div(market.base_reserve)
        .ok_or(PerkError::MathOverflow)?;
    // Convert to u64 PRICE_SCALE (price is already in PEG_SCALE, which equals PRICE_SCALE)
    Ok(price as u64)
}

/// Simulate opening a long position (buying base from the vAMM)
/// Returns the quote cost and execution details
pub fn simulate_long(market: &Market, base_size: u128) -> Result<SwapResult> {
    require!(base_size > 0, PerkError::InvalidAmount);
    require!(base_size < market.base_reserve, PerkError::InvalidAmount);

    let new_base = market
        .base_reserve
        .checked_sub(base_size)
        .ok_or(PerkError::MathOverflow)?;

    let new_quote = market
        .k
        .checked_div(new_base)
        .ok_or(PerkError::MathOverflow)?;

    let quote_cost = new_quote
        .checked_sub(market.quote_reserve)
        .ok_or(PerkError::MathOverflow)?;

    // execution_price = (quote_cost * peg_multiplier) / base_size
    let exec_price = quote_cost
        .checked_mul(market.peg_multiplier)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(base_size)
        .ok_or(PerkError::MathOverflow)?;

    Ok(SwapResult {
        base_amount: base_size,
        quote_amount: quote_cost,
        new_base_reserve: new_base,
        new_quote_reserve: new_quote,
        execution_price: exec_price,
    })
}

/// Simulate opening a short position (selling base to the vAMM)
/// Returns the quote received and execution details
pub fn simulate_short(market: &Market, base_size: u128) -> Result<SwapResult> {
    require!(base_size > 0, PerkError::InvalidAmount);

    let new_base = market
        .base_reserve
        .checked_add(base_size)
        .ok_or(PerkError::MathOverflow)?;

    let new_quote = market
        .k
        .checked_div(new_base)
        .ok_or(PerkError::MathOverflow)?;

    let quote_received = market
        .quote_reserve
        .checked_sub(new_quote)
        .ok_or(PerkError::MathOverflow)?;

    // execution_price = (quote_received * peg_multiplier) / base_size
    let exec_price = quote_received
        .checked_mul(market.peg_multiplier)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(base_size)
        .ok_or(PerkError::MathOverflow)?;

    Ok(SwapResult {
        base_amount: base_size,
        quote_amount: quote_received,
        new_base_reserve: new_base,
        new_quote_reserve: new_quote,
        execution_price: exec_price,
    })
}

/// Apply a swap result to the market state
pub fn apply_swap(market: &mut Market, result: &SwapResult) {
    market.base_reserve = result.new_base_reserve;
    market.quote_reserve = result.new_quote_reserve;
}

/// Calculate notional value: base_size * execution_price / PRICE_SCALE
pub fn calculate_notional(base_size: u128, price: u64) -> Result<u128> {
    let notional = base_size
        .checked_mul(price as u128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(PRICE_SCALE as u128)
        .ok_or(PerkError::MathOverflow)?;
    Ok(notional)
}

/// Calculate trading fee: ceil(notional * fee_bps / 10000)
/// Uses ceiling division so fees always round UP (against user, in protocol's favor).
pub fn calculate_fee(notional: u128, fee_bps: u16) -> Result<u128> {
    let numerator = notional
        .checked_mul(fee_bps as u128)
        .ok_or(PerkError::MathOverflow)?;
    let fee = numerator
        .checked_add(BPS_DENOMINATOR as u128 - 1)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(PerkError::MathOverflow)?;
    Ok(fee)
}

/// H1 (Pashov3): Compute fee split, returning (creator_fee, protocol_fee).
/// If the caller IS the creator, all fees go to protocol (no self-rebate).
pub fn compute_fee_split(amount: u128, creator_share_bps: u16, is_creator: bool) -> (u128, u128) {
    if is_creator {
        return (0, amount);
    }
    let creator = amount.checked_mul(creator_share_bps as u128).unwrap_or(0) / 10_000;
    (creator, amount.saturating_sub(creator))
}

/// Split fee: creator_share (10%), protocol_share (90%)
pub fn split_fee(total_fee: u128, creator_share_bps: u16) -> Result<(u128, u128)> {
    let creator_fee = total_fee
        .checked_mul(creator_share_bps as u128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR as u128)
        .ok_or(PerkError::MathOverflow)?;
    let protocol_fee = total_fee
        .checked_sub(creator_fee)
        .ok_or(PerkError::MathOverflow)?;
    Ok((creator_fee, protocol_fee))
}

/// Calculate slippage in bps: |exec_price - oracle_price| * 10000 / oracle_price
pub fn calculate_slippage_bps(exec_price: u128, oracle_price: u64) -> Result<u16> {
    if oracle_price == 0 {
        return Err(PerkError::OraclePriceInvalid.into());
    }
    let diff = if exec_price > oracle_price as u128 {
        exec_price.checked_sub(oracle_price as u128).ok_or(PerkError::MathOverflow)?
    } else {
        (oracle_price as u128).checked_sub(exec_price).ok_or(PerkError::MathOverflow)?
    };
    let slippage = diff
        .checked_mul(BPS_DENOMINATOR as u128)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(oracle_price as u128)
        .ok_or(PerkError::MathOverflow)?;
    Ok(slippage as u16)
}

/// Initialize vAMM reserves from initial_k and oracle price
/// Sets base_reserve = quote_reserve = sqrt(k), peg = oracle_price
pub fn initialize_vamm(initial_k: u128, oracle_price: u64) -> Result<(u128, u128, u128)> {
    // base = quote = sqrt(k)
    let sqrt_k = integer_sqrt(initial_k);
    require!(sqrt_k > 0, PerkError::InitialKTooSmall);

    // Recalculate k to be exact: sqrt_k * sqrt_k
    let _k = sqrt_k
        .checked_mul(sqrt_k)
        .ok_or(PerkError::MathOverflow)?;

    Ok((sqrt_k, sqrt_k, oracle_price as u128))
}

/// Normalize vAMM reserves to balanced state after ADL drain.
/// Resets base = quote = sqrt(k), keeping k constant. Mark price becomes peg_multiplier.
/// Safe because PnL is K-diff (oracle-based), not vAMM-based.
pub fn normalize_reserves(market: &mut Market) {
    let sqrt_k = integer_sqrt(market.k);
    if sqrt_k > 0 {
        market.base_reserve = sqrt_k;
        market.quote_reserve = sqrt_k;
        // k stays the same (sqrt_k * sqrt_k ≈ k, may lose 1 unit to rounding)
        market.k = sqrt_k.checked_mul(sqrt_k).unwrap_or(market.k);
    }
}

/// Integer square root via binary search
pub fn integer_sqrt(n: u128) -> u128 {
    if n == 0 {
        return 0;
    }
    let mut x = n;
    let mut y = (x.checked_add(1).unwrap_or(u128::MAX)).checked_div(2).unwrap_or(0);
    while y < x {
        x = y;
        y = (x.checked_add(n.checked_div(x).unwrap_or(0)).unwrap_or(u128::MAX))
            .checked_div(2)
            .unwrap_or(0);
    }
    x
}

/// Update peg multiplier to re-anchor mark price toward oracle
pub fn calculate_new_peg(market: &Market, oracle_price: u64) -> Result<u128> {
    if market.base_reserve == 0 {
        return Err(PerkError::MathOverflow.into());
    }
    // We want: new_peg * quote_reserve / base_reserve = oracle_price
    // So: new_peg = oracle_price * base_reserve / quote_reserve
    let new_peg = (oracle_price as u128)
        .checked_mul(market.base_reserve)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(market.quote_reserve)
        .ok_or(PerkError::MathOverflow)?;
    Ok(new_peg)
}
