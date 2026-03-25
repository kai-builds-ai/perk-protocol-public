use anchor_lang::prelude::*;
use anchor_spl::token::{Mint, Token, TokenAccount};
use crate::constants::*;
use crate::engine::{oracle, vamm};
use crate::errors::PerkError;
use crate::state::{Market, OracleSource, Protocol, SideState};

/// Integer square root via Newton's method (deterministic, no floats)
fn integer_sqrt(n: u128) -> u128 {
    if n == 0 { return 0; }
    let mut x = n;
    let mut y = (x + 1) / 2;
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
}

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct CreateMarketParams {
    pub oracle_source: OracleSource,
    pub max_leverage: u32,
    pub trading_fee_bps: u16,
    pub initial_k: u128,
}

#[derive(Accounts)]
pub struct CreateMarket<'info> {
    #[account(
        mut,
        seeds = [b"protocol"],
        bump = protocol.bump,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        init,
        payer = creator,
        space = Market::SIZE,
        seeds = [b"market", token_mint.key().as_ref()],
        bump,
    )]
    pub market: Box<Account<'info, Market>>,

    pub token_mint: Account<'info, Mint>,

    /// CHECK: Oracle price feed account (validated in handler)
    pub oracle: UncheckedAccount<'info>,

    // C2: Vault authority is the Market PDA (not the vault itself)
    #[account(
        init,
        payer = creator,
        token::mint = token_mint,
        token::authority = market,
        seeds = [b"vault", market.key().as_ref()],
        bump,
    )]
    pub vault: Account<'info, TokenAccount>,

    #[account(mut)]
    pub creator: Signer<'info>,

    pub system_program: Program<'info, System>,
    pub token_program: Program<'info, Token>,
    pub rent: Sysvar<'info, Rent>,
}

pub fn handler(ctx: Context<CreateMarket>, params: CreateMarketParams) -> Result<()> {
    let protocol = &ctx.accounts.protocol;

    // Validate not paused
    require!(!protocol.paused, PerkError::ProtocolPaused);

    // H10: Reject DexPool oracle source until implemented
    require!(
        params.oracle_source != OracleSource::DexPool,
        PerkError::DexPoolOracleNotSupported
    );

    // Validate fee bounds
    require!(
        params.trading_fee_bps >= protocol.min_trading_fee_bps
            && params.trading_fee_bps <= protocol.max_trading_fee_bps,
        PerkError::InvalidTradingFee
    );

    // Validate leverage bounds
    require!(
        params.max_leverage >= MIN_LEVERAGE && params.max_leverage <= MAX_LEVERAGE,
        PerkError::InvalidLeverage
    );

    // Validate initial k
    require!(
        params.initial_k >= protocol.min_initial_liquidity as u128,
        PerkError::InitialKTooSmall
    );

    // Validate token mint decimals
    require!(
        ctx.accounts.token_mint.decimals >= MIN_TOKEN_DECIMALS
            && ctx.accounts.token_mint.decimals <= MAX_TOKEN_DECIMALS,
        PerkError::InvalidTokenDecimals
    );

    // Validate oracle
    oracle::validate_oracle(
        &params.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
    )?;

    // PerkOracle: verify the oracle's token_mint matches this market's token
    if params.oracle_source == OracleSource::PerkOracle {
        oracle::validate_perk_oracle_mint(
            &ctx.accounts.oracle.to_account_info(),
            &ctx.accounts.token_mint.key(),
        )?;
    }

    // Read initial oracle price for peg
    let clock = Clock::get()?;
    let oracle_price_result = oracle::read_oracle_price(
        &params.oracle_source,
        &ctx.accounts.oracle.to_account_info(),
        clock.unix_timestamp,
    )?;

    // Initialize vAMM
    let (base_reserve, quote_reserve, peg) =
        vamm::initialize_vamm(params.initial_k, oracle_price_result.price)?;

    // Set up market
    let market = &mut ctx.accounts.market;
    let protocol_mut = &mut ctx.accounts.protocol;

    market.market_index = protocol_mut.market_count;
    market.token_mint = ctx.accounts.token_mint.key();
    market.collateral_mint = ctx.accounts.token_mint.key(); // Coin-margined
    market.creator = ctx.accounts.creator.key();
    market.vault = ctx.accounts.vault.key();
    market.vault_bump = ctx.bumps.vault;

    // vAMM state
    market.base_reserve = base_reserve;
    market.quote_reserve = quote_reserve;
    market.k = base_reserve.checked_mul(quote_reserve).ok_or(PerkError::MathOverflow)?;
    market.peg_multiplier = peg;
    market.total_long_position = 0;
    market.total_short_position = 0;

    // Parameters (immutable after creation)
    market.max_leverage = params.max_leverage;
    market.trading_fee_bps = params.trading_fee_bps;
    market.liquidation_fee_bps = LIQUIDATION_FEE_BPS;
    market.maintenance_margin_bps = MAINTENANCE_MARGIN_BPS;

    // Oracle
    market.oracle_source = params.oracle_source;
    market.oracle_address = ctx.accounts.oracle.key();

    // Risk engine state (initialized)
    market.insurance_fund_balance = 0;
    market.haircut_numerator = 1;
    market.haircut_denominator = 1;
    market.long_a = ADL_ONE;
    market.long_k_index = 0;
    market.long_epoch = 0;
    market.long_state = SideState::Normal;
    market.long_epoch_start_k = 0;
    market.short_a = ADL_ONE;
    market.short_k_index = 0;
    market.short_epoch = 0;
    market.short_state = SideState::Normal;
    market.short_epoch_start_k = 0;

    // Funding
    market.last_funding_time = clock.unix_timestamp;
    market.cumulative_long_funding = 0;
    market.cumulative_short_funding = 0;
    market.funding_period_seconds = DEFAULT_FUNDING_PERIOD;
    market.funding_rate_cap_bps = FUNDING_RATE_CAP_BPS;

    // Warmup — validate minimum warmup period
    require!(
        WARMUP_PERIOD_SLOTS >= MIN_WARMUP_PERIOD_SLOTS,
        PerkError::WarmupPeriodTooSmall
    );
    market.warmup_period_slots = WARMUP_PERIOD_SLOTS;

    // Fees
    market.creator_fees_earned = 0;
    market.protocol_fees_earned = 0;
    market.total_volume = 0;

    // State
    market.active = true;
    market.total_users = 0;
    market.total_positions = 0;

    // Aggregates
    market.c_tot = 0;
    market.pnl_pos_tot = 0;
    market.pnl_matured_pos_tot = 0;
    market.vault_balance = 0;
    market.oi_eff_long_q = 0;
    market.oi_eff_short_q = 0;
    market.stored_pos_count_long = 0;
    market.stored_pos_count_short = 0;

    // H1 fix: Position size limits relative to sqrt(k), not k itself.
    // k/10 and k/2 never bind because vAMM constraint base_size < sqrt(k) is stricter.
    // Use integer sqrt (Newton's method) for determinism.
    let sqrt_k = integer_sqrt(market.k);
    market.max_position_size = sqrt_k / 5;  // 20% of reserves per position
    market.max_oi = sqrt_k / 2;             // 50% of reserves per side

    // H3: Peg update cooldown tracking
    market.last_peg_update_slot = 0;

    // H4: TWAP mark price for funding
    market.last_mark_price_for_funding = oracle_price_result.price;

    // C7: Claimable fees
    market.creator_claimable_fees = 0;
    market.protocol_claimable_fees = 0;

    // H6: Insurance epoch tracking
    market.insurance_epoch_start = clock.unix_timestamp;
    market.insurance_epoch_payout = 0;

    market.bump = ctx.bumps.market;
    market.created_at = clock.unix_timestamp;

    // H4 fix: Deferred reset flags
    market.pending_reset_long = false;
    market.pending_reset_short = false;

    // M8 fix: TWAP accumulator
    market.mark_price_accumulator = 0;
    market.twap_observation_count = 0;

    // M3: creation fee tracked below
    market.creation_fee_paid = 0;

    // M3 fix: Charge market creation fee (SOL transfer to protocol treasury)
    let creation_fee = protocol_mut.market_creation_fee;
    if creation_fee > 0 {
        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.creator.key(),
            &protocol_mut.key(),
            creation_fee,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.creator.to_account_info(),
                protocol_mut.to_account_info(),
                ctx.accounts.system_program.to_account_info(),
            ],
        )?;
        market.creation_fee_paid = creation_fee;
    }

    // Increment protocol market count
    protocol_mut.market_count = protocol_mut
        .market_count
        .checked_add(1)
        .ok_or(PerkError::MathOverflow)?;

    msg!(
        "Market created: index={}, token={}, creator={}, k={}, fee={}bps, max_leverage={}",
        market.market_index,
        market.token_mint,
        market.creator,
        market.k,
        market.trading_fee_bps,
        market.max_leverage,
    );

    Ok(())
}
