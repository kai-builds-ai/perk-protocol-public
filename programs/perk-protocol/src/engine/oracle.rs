/// Oracle Engine
///
/// Reads oracle prices from Pyth PriceUpdateV2 accounts via the official SDK.
/// Validates staleness, confidence, and price positivity.
/// DEX oracle reads are stubbed for future implementation.

use crate::constants::*;
use crate::errors::PerkError;
use crate::state::OracleSource;
use anchor_lang::prelude::*;
use pyth_solana_receiver_sdk::price_update::PriceUpdateV2;

/// Oracle price result
pub struct OraclePrice {
    pub price: u64,      // Scaled by PRICE_SCALE (6 decimals)
    pub confidence: u64,  // Scaled by PRICE_SCALE (6 decimals)
    pub timestamp: i64,   // Unix timestamp of the price
}

/// Maximum staleness for oracle prices (seconds)
const MAX_STALENESS: i64 = ORACLE_STALENESS_SECONDS as i64;

/// Target decimal places for price scaling
const PRICE_DECIMALS: i32 = 6;

/// Read oracle price from account data
///
/// For Pyth: deserializes PriceUpdateV2 and validates staleness + confidence
/// For DEX: rejected until implemented
pub fn read_oracle_price(
    oracle_source: &OracleSource,
    oracle_account: &AccountInfo,
    current_time: i64,
) -> Result<OraclePrice> {
    match oracle_source {
        OracleSource::Pyth => read_pyth_price(oracle_account, current_time),
        OracleSource::DexPool => Err(PerkError::DexPoolOracleNotSupported.into()),
    }
}

/// Read and validate a Pyth price feed via PriceUpdateV2
fn read_pyth_price(
    oracle_account: &AccountInfo,
    current_time: i64,
) -> Result<OraclePrice> {
    // Deserialize as PriceUpdateV2 (checks 8-byte discriminator)
    let price_update = deserialize_price_update(oracle_account)?;
    let msg = &price_update.price_message;

    // Validate price is positive
    require!(msg.price > 0, PerkError::OraclePriceInvalid);

    // Validate staleness
    let age = current_time.saturating_sub(msg.publish_time);
    require!(age <= MAX_STALENESS, PerkError::OracleStale);
    require!(age >= 0, PerkError::OraclePriceInvalid); // future timestamps rejected

    // Scale price and confidence to PRICE_SCALE (6 decimals)
    let price_scaled = scale_pyth_price(msg.price as u64, msg.exponent)?;
    let conf_scaled = scale_pyth_price(msg.conf, msg.exponent)?;

    // Reject zero after scaling (precision loss on very low-value tokens)
    require!(price_scaled > 0, PerkError::OraclePriceInvalid);

    // Validate confidence: reject if conf > price * ORACLE_CONFIDENCE_BPS / 10000
    let max_conf = price_scaled
        .checked_mul(ORACLE_CONFIDENCE_BPS as u64)
        .ok_or(PerkError::MathOverflow)?
        .checked_div(BPS_DENOMINATOR)
        .ok_or(PerkError::MathOverflow)?;
    require!(conf_scaled <= max_conf, PerkError::OracleConfidenceTooWide);

    Ok(OraclePrice {
        price: price_scaled,
        confidence: conf_scaled,
        timestamp: msg.publish_time,
    })
}

/// Deserialize a PriceUpdateV2 from an AccountInfo, with owner check
fn deserialize_price_update(oracle_account: &AccountInfo) -> Result<PriceUpdateV2> {
    // Verify the account is owned by the Pyth receiver program
    require!(
        oracle_account.owner == &pyth_solana_receiver_sdk::ID,
        PerkError::InvalidOracleSource
    );

    let data = oracle_account.try_borrow_data()?;
    let mut data_slice: &[u8] = &data;
    PriceUpdateV2::try_deserialize(&mut data_slice)
        .map_err(|_| error!(PerkError::InvalidOracleSource))
}

/// Scale a Pyth price to PRICE_SCALE (6 decimals).
///
/// Real price = raw_price * 10^expo
/// Scaled     = raw_price * 10^(expo + PRICE_DECIMALS)
///
/// Examples:
///   SOL:   price=15032000000,   expo=-8 → shift=-2 → 15032000000 / 100   = 150_320_000
///   BTC:   price=6789100000000, expo=-8 → shift=-2 → 6789100000000 / 100 = 67_891_000_000_000
///   Small: price=1,             expo=-4 → shift=+2 → 1 * 100             = 100
fn scale_pyth_price(price: u64, expo: i32) -> Result<u64> {
    let shift = expo
        .checked_add(PRICE_DECIMALS)
        .ok_or(PerkError::MathOverflow)?;

    if shift >= 0 {
        let factor = 10u64
            .checked_pow(shift as u32)
            .ok_or(PerkError::MathOverflow)?;
        price
            .checked_mul(factor)
            .ok_or_else(|| error!(PerkError::MathOverflow))
    } else {
        let factor = 10u64
            .checked_pow((-shift) as u32)
            .ok_or(PerkError::MathOverflow)?;
        price
            .checked_div(factor)
            .ok_or_else(|| error!(PerkError::MathOverflow))
    }
}

/// Validate that an oracle account can be used as a price source
pub fn validate_oracle(
    oracle_source: &OracleSource,
    oracle_account: &AccountInfo,
) -> Result<()> {
    match oracle_source {
        OracleSource::Pyth => {
            // Verify the account deserializes as a valid PriceUpdateV2
            deserialize_price_update(oracle_account)?;
            Ok(())
        }
        OracleSource::DexPool => Err(PerkError::DexPoolOracleNotSupported.into()),
    }
}
