/// M4 fix: Admin market update instruction.
/// Allows admin to update oracle_address, active status, and trading_fee_bps.

use anchor_lang::prelude::*;
use anchor_lang::prelude::InterfaceAccount;
use anchor_spl::token_interface::Mint;
use crate::constants::{MIN_LEVERAGE, MAX_LEVERAGE};
use crate::engine::oracle;
use crate::errors::PerkError;
use crate::state::{Market, Protocol};

#[derive(AnchorSerialize, AnchorDeserialize, Clone)]
pub struct AdminUpdateMarketParams {
    /// New oracle address (None = keep current)
    pub oracle_address: Option<Pubkey>,
    /// Set market active/inactive (None = keep current)
    pub active: Option<bool>,
    /// New trading fee in BPS (None = keep current)
    pub trading_fee_bps: Option<u16>,
    /// H4 (Pashov2): New max leverage (100x-scaled, e.g. 2000 = 20x). None = keep current.
    pub max_leverage: Option<u32>,
    /// New collateral mint (None = keep current). Must be 6 decimals.
    pub collateral_mint: Option<Pubkey>,
}

#[derive(Accounts)]
pub struct AdminUpdateMarket<'info> {
    #[account(
        seeds = [b"protocol"],
        bump = protocol.bump,
        constraint = protocol.admin == admin.key() @ PerkError::Unauthorized,
    )]
    pub protocol: Box<Account<'info, Protocol>>,

    #[account(
        mut,
        seeds = [b"market", market.token_mint.as_ref(), market.creator.as_ref()],
        bump = market.bump,
    )]
    pub market: Box<Account<'info, Market>>,

    /// CHECK: New oracle account (only validated if oracle_address is being updated)
    pub oracle: Option<UncheckedAccount<'info>>,

    /// New collateral mint (only validated if collateral_mint is being updated)
    pub new_collateral_mint: Option<InterfaceAccount<'info, Mint>>,

    pub admin: Signer<'info>,
}

pub fn handler(ctx: Context<AdminUpdateMarket>, params: AdminUpdateMarketParams) -> Result<()> {
    let market = &mut ctx.accounts.market;
    let protocol = &ctx.accounts.protocol;

    // Update oracle address with validation
    if let Some(new_oracle) = params.oracle_address {
        let oracle_account = ctx.accounts.oracle.as_ref()
            .ok_or(PerkError::InvalidOracleSource)?;
        require!(oracle_account.key() == new_oracle, PerkError::InvalidOracleSource);

        // Validate the new oracle
        oracle::validate_oracle(
            &market.oracle_source,
            &oracle_account.to_account_info(),
        )?;

        market.oracle_address = new_oracle;
        msg!("Oracle updated to {}", new_oracle);
    }

    // Update active status
    if let Some(active) = params.active {
        market.active = active;
        msg!("Market active status set to {}", active);
    }

    // Update trading fee (within bounds)
    if let Some(fee_bps) = params.trading_fee_bps {
        require!(
            fee_bps >= protocol.min_trading_fee_bps && fee_bps <= protocol.max_trading_fee_bps,
            PerkError::InvalidTradingFee
        );
        market.trading_fee_bps = fee_bps;
        msg!("Trading fee updated to {}bps", fee_bps);
    }

    // H4 (Pashov2): Update max leverage
    if let Some(leverage) = params.max_leverage {
        require!(
            leverage >= MIN_LEVERAGE && leverage <= MAX_LEVERAGE,
            PerkError::InvalidLeverage
        );
        market.max_leverage = leverage;
        msg!("Max leverage updated to {}", leverage);
    }

    // Update collateral mint (must be 6 decimals for Percolator math)
    if let Some(new_col) = params.collateral_mint {
        let mint_account = ctx.accounts.new_collateral_mint.as_ref()
            .ok_or(PerkError::TokenMintMismatch)?;
        require!(mint_account.key() == new_col, PerkError::TokenMintMismatch);
        require!(mint_account.decimals == 6, PerkError::InvalidTokenDecimals);
        market.collateral_mint = new_col;
        msg!("Collateral mint updated to {}", new_col);
    }

    Ok(())
}
