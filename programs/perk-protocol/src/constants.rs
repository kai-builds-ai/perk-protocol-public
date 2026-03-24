// ============================================================================
// Constants — from ARCHITECTURE.md + Percolator Normative Bounds
// ============================================================================

// Protocol
pub const CREATOR_FEE_SHARE_BPS: u16 = 1000; // 10% of fees to creator
pub const MIN_TRADING_FEE_BPS: u16 = 3; // 0.03% minimum
pub const LIQUIDATION_FEE_BPS: u16 = 100; // 1%
pub const LIQUIDATOR_SHARE_BPS: u16 = 5000; // 50% of liq fee to liquidator
pub const TRIGGER_EXECUTION_FEE_BPS: u16 = 1; // 0.01% to executor

// Market defaults
pub const DEFAULT_MAX_LEVERAGE: u32 = 2000; // 20x
pub const MAINTENANCE_MARGIN_BPS: u16 = 500; // 5%
pub const DEFAULT_FUNDING_PERIOD: u32 = 3600; // 1 hour
pub const FUNDING_RATE_CAP_BPS: u16 = 10; // 0.1% per period
pub const WARMUP_PERIOD_SLOTS: u64 = 1000; // ~400 seconds
pub const MAX_TRIGGER_ORDERS_PER_USER: u8 = 8;

// Oracle
pub const ORACLE_STALENESS_SECONDS: u32 = 15;
pub const ORACLE_CONFIDENCE_BPS: u16 = 200; // 2%
pub const AMM_PEG_THRESHOLD_BPS: u16 = 50; // 0.5% drift triggers re-peg

// Precision
pub const PRICE_SCALE: u64 = 1_000_000; // 6 decimals
pub const K_SCALE: u128 = 1_000_000_000_000; // 12 decimals for k precision

// M9 fix: Minimum k raised to 1e18 for meaningful depth (sqrt(1e18) = 1e9 base reserve)
pub const MIN_INITIAL_K: u128 = 1_000_000_000_000_000_000;
pub const PEG_SCALE: u128 = 1_000_000; // 6 decimals

// Percolator risk engine — core scales (spec §1.2-1.4)
pub const POS_SCALE: u128 = 1_000_000;
pub const ADL_ONE: u128 = 1_000_000;
pub const MIN_A_SIDE: u128 = 1_000;

// Percolator normative bounds (spec §1.4)
pub const MAX_ORACLE_PRICE: u64 = 1_000_000_000_000;
pub const MAX_FUNDING_DT: u64 = u16::MAX as u64;
pub const MAX_ABS_FUNDING_BPS_PER_SLOT: i64 = 10_000;
pub const MAX_VAULT_TVL: u128 = 10_000_000_000_000_000;
pub const MAX_POSITION_ABS_Q: u128 = 100_000_000_000_000;
pub const MAX_ACCOUNT_NOTIONAL: u128 = 100_000_000_000_000_000_000;
pub const MAX_TRADE_SIZE_Q: u128 = MAX_POSITION_ABS_Q;
pub const MAX_OI_SIDE_Q: u128 = 100_000_000_000_000;
pub const MAX_MATERIALIZED_ACCOUNTS: u64 = 1_000_000;
pub const MAX_ACCOUNT_POSITIVE_PNL: u128 = 100_000_000_000_000_000_000_000_000_000_000;
pub const MAX_PNL_POS_TOT: u128 = 100_000_000_000_000_000_000_000_000_000_000_000_000;
pub const MAX_TRADING_FEE_BPS: u64 = 100; // 1% max — prevents honeypot markets
pub const MAX_MARGIN_BPS: u64 = 10_000;
pub const MAX_LIQUIDATION_FEE_BPS: u64 = 10_000;
pub const MAX_PROTOCOL_FEE_ABS: u128 = MAX_ACCOUNT_NOTIONAL;

// Leverage bounds
pub const MIN_LEVERAGE: u32 = 200; // 2x
pub const MAX_LEVERAGE: u32 = 2000; // 20x

// BPS denominator
pub const BPS_DENOMINATOR: u64 = 10_000;

// C1 (R3): Funding rate precision multiplier — prevents integer truncation
// when dividing small bps rates by large slots_per_period
pub const FUNDING_RATE_PRECISION: i64 = 1_000_000;

// === Security fixes ===

// H2 fix: AMM peg update cooldown increased from 10 to 100 (~40 seconds) to prevent sandwich
pub const PEG_UPDATE_COOLDOWN_SLOTS: u64 = 100;

// H6: Insurance fund epoch payout cap (50% of balance per epoch)
pub const INSURANCE_EPOCH_CAP_BPS: u16 = 5000;

// H3 fix: Insurance epoch is 24 hours, decoupled from funding period.
// Prevents timing attack where crank_funding resets the insurance counter.
pub const INSURANCE_EPOCH_SECONDS: i64 = 86400;

// H1: Default position size limits (relative to k)
pub const DEFAULT_MAX_POSITION_SIZE_DIVISOR: u128 = 10;
pub const DEFAULT_MAX_OI_DIVISOR: u128 = 2;

// Medium fix: Minimum warmup period (prevent set to 0)
pub const MIN_WARMUP_PERIOD_SLOTS: u64 = 100;

// Medium fix: Minimum deposit to prevent dust positions
pub const MIN_DEPOSIT_AMOUNT: u64 = 1_000;

// M1 fix: Minimum non-zero maintenance margin requirement (0.01 token in base units)
pub const MIN_NONZERO_MM_REQ: u128 = 10_000;

// C2 (Pashov2): Minimum non-zero initial margin requirement
// M2 (Pashov3): Must be > MIN_NONZERO_MM_REQ (was 10,000, now 20,000)
pub const MIN_NONZERO_IM_REQ: u128 = 20_000;

// Medium fix: Minimum remaining position size after partial close
pub const MIN_REMAINING_POSITION_SIZE: u64 = 100;

// Medium fix: Maximum trigger order age (30 days)
pub const MAX_TRIGGER_ORDER_AGE_SECONDS: i64 = 30 * 24 * 3600;

// M3 fix: Default market creation fee (1 SOL in lamports)
pub const DEFAULT_MARKET_CREATION_FEE: u64 = 1_000_000_000;

// C5: Minimum delay before empty account can be reclaimed (~6 minutes)
pub const MIN_RECLAIM_DELAY_SLOTS: u64 = 1000;

// C5: Dust threshold for collateral (below this, position is reclaimable)
pub const DUST_THRESHOLD: u64 = 1000;

// Medium fix: Token mint decimal bounds
pub const MIN_TOKEN_DECIMALS: u8 = 0;
pub const MAX_TOKEN_DECIMALS: u8 = 18;
