use anchor_lang::prelude::*;

#[error_code]
pub enum PerkError {
    #[msg("Protocol is paused")]
    ProtocolPaused,
    #[msg("Market is not active")]
    MarketNotActive,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Math overflow")]
    MathOverflow,
    #[msg("Insufficient collateral")]
    InsufficientCollateral,
    #[msg("Insufficient margin")]
    InsufficientMargin,
    #[msg("Invalid leverage")]
    InvalidLeverage,
    #[msg("Slippage exceeded")]
    SlippageExceeded,
    #[msg("Invalid trading fee")]
    InvalidTradingFee,
    #[msg("Initial k too small")]
    InitialKTooSmall,
    #[msg("Oracle price is stale")]
    OracleStale,
    #[msg("Oracle confidence too wide")]
    OracleConfidenceTooWide,
    #[msg("Oracle price invalid")]
    OraclePriceInvalid,
    #[msg("Position not found")]
    PositionNotFound,
    #[msg("Position not liquidatable")]
    NotLiquidatable,
    #[msg("Max trigger orders reached")]
    MaxTriggerOrdersReached,
    #[msg("Trigger condition not met")]
    TriggerConditionNotMet,
    #[msg("Trigger order expired")]
    TriggerOrderExpired,
    #[msg("No open position")]
    NoOpenPosition,
    #[msg("Position already exists")]
    PositionAlreadyExists,
    #[msg("Reduce only violation")]
    ReduceOnlyViolation,
    #[msg("Side blocked - drain only mode")]
    SideBlocked,
    #[msg("Corrupt state")]
    CorruptState,
    #[msg("Invalid oracle source")]
    InvalidOracleSource,
    #[msg("Withdrawal would make position underwater")]
    WithdrawalWouldLiquidate,
    #[msg("Market already exists for this token")]
    MarketAlreadyExists,
    #[msg("Funding period not elapsed")]
    FundingPeriodNotElapsed,
    #[msg("AMM peg within threshold")]
    AmmPegWithinThreshold,
    #[msg("Invalid collateral amount")]
    InvalidAmount,
    // === New error variants for security fixes ===
    #[msg("Position flip not allowed — close first, then reopen")]
    PositionFlipNotAllowed,
    #[msg("AMM peg update cooldown not elapsed")]
    PegCooldownNotElapsed,
    #[msg("Insurance fund epoch payout cap exceeded")]
    InsuranceEpochCapExceeded,
    #[msg("Position size exceeds market limit")]
    PositionSizeLimitExceeded,
    #[msg("Open interest exceeds market limit")]
    OiLimitExceeded,
    #[msg("DexPool oracle source not yet supported")]
    DexPoolOracleNotSupported,
    #[msg("Position not initialized — call initialize_position first")]
    PositionNotInitialized,
    #[msg("Insufficient OI on both sides for funding")]
    InsufficientOiForFunding,
    #[msg("No fees to claim")]
    NoFeesToClaim,
    #[msg("Deposit below minimum amount")]
    DepositBelowMinimum,
    #[msg("Remaining position size below minimum after partial close")]
    RemainingPositionTooSmall,
    #[msg("Trigger order too old (exceeded max age)")]
    TriggerOrderTooOld,
    #[msg("Token mint decimals out of supported range")]
    InvalidTokenDecimals,
    #[msg("Warmup period below minimum")]
    WarmupPeriodTooSmall,
    #[msg("Position is not empty — cannot reclaim")]
    PositionNotEmpty,
    #[msg("Position has open trigger orders — cannot reclaim")]
    PositionHasOpenOrders,
    #[msg("Vault insufficient for transfer")]
    VaultInsufficient,
    #[msg("Account too young to reclaim")]
    ReclaimTooSoon,
    #[msg("Account has outstanding fee debt — cannot reclaim")]
    ReclaimFeeDebt,
    #[msg("Account collateral above dust threshold — cannot reclaim")]
    ReclaimCollateralAboveDust,
    #[msg("Admin transfer already pending — accept or cancel first")]
    AdminTransferPending,
    #[msg("Must wait at least 1 slot before closing position")]
    MinHoldingPeriodNotMet,
}
