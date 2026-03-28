use anchor_lang::prelude::*;

pub mod constants;
pub mod errors;
pub mod state;
pub mod engine;
pub mod instructions;

use instructions::*;
use state::Side;

declare_id!("3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2");

#[program]
pub mod perk_protocol {
    use super::*;

    /// Initialize the protocol singleton. Called once by admin.
    pub fn initialize_protocol(ctx: Context<InitializeProtocol>) -> Result<()> {
        instructions::initialize_protocol::handler(ctx)
    }

    /// Create a new perpetual futures market. Permissionless — anyone can call.
    pub fn create_market(
        ctx: Context<CreateMarket>,
        params: CreateMarketParams,
    ) -> Result<()> {
        instructions::create_market::handler(ctx, params)
    }

    /// C12: Initialize a user position account. Must be called before deposit.
    pub fn initialize_position(ctx: Context<InitializePosition>) -> Result<()> {
        instructions::initialize_position::handler(ctx)
    }

    /// Deposit collateral into a market position.
    pub fn deposit(ctx: Context<Deposit>, amount: u64) -> Result<()> {
        instructions::deposit::handler(ctx, amount)
    }

    /// Withdraw collateral from a market position.
    pub fn withdraw(ctx: Context<Withdraw>, amount: u64) -> Result<()> {
        instructions::withdraw::handler(ctx, amount)
    }

    /// Open a leveraged position via vAMM.
    pub fn open_position(
        ctx: Context<OpenPosition>,
        side: Side,
        base_size: u64,
        leverage: u32,
        max_slippage_bps: u16,
    ) -> Result<()> {
        instructions::open_position::handler(ctx, side, base_size, leverage, max_slippage_bps)
    }

    /// Close a position (fully or partially).
    pub fn close_position(
        ctx: Context<ClosePosition>,
        base_size_to_close: Option<u64>,
    ) -> Result<()> {
        instructions::close_position::handler(ctx, base_size_to_close)
    }

    /// Place a trigger order (limit, stop-loss, take-profit).
    pub fn place_trigger_order(
        ctx: Context<PlaceTriggerOrder>,
        params: TriggerOrderParams,
    ) -> Result<()> {
        instructions::place_trigger_order::handler(ctx, params)
    }

    /// Execute a trigger order. Permissionless — anyone can call (cranker incentive).
    pub fn execute_trigger_order(ctx: Context<ExecuteTriggerOrder>) -> Result<()> {
        instructions::execute_trigger_order::handler(ctx)
    }

    /// Cancel a trigger order.
    pub fn cancel_trigger_order(ctx: Context<CancelTriggerOrder>) -> Result<()> {
        instructions::cancel_trigger_order::handler(ctx)
    }

    /// Liquidate an underwater position. Permissionless.
    pub fn liquidate(ctx: Context<Liquidate>) -> Result<()> {
        instructions::liquidate::handler(ctx)
    }

    /// Crank the funding rate. Permissionless.
    pub fn crank_funding(ctx: Context<CrankFunding>) -> Result<()> {
        instructions::crank_funding::handler(ctx)
    }

    /// Update AMM peg multiplier to re-anchor to oracle. Permissionless.
    pub fn update_amm(ctx: Context<UpdateAmm>) -> Result<()> {
        instructions::update_amm::handler(ctx)
    }

    /// Emergency pause/unpause. Admin only.
    pub fn admin_pause(ctx: Context<AdminPause>, paused: bool) -> Result<()> {
        instructions::admin_pause::handler(ctx, paused)
    }

    /// C7: Claim accumulated trading fees. Creator or protocol admin.
    pub fn claim_fees(ctx: Context<ClaimFees>) -> Result<()> {
        instructions::claim_fees::handler(ctx)
    }

    /// Reclaim an empty position account. Permissionless.
    /// Sweeps dust capital to insurance, closes account, returns rent.
    pub fn reclaim_empty_account(ctx: Context<ReclaimEmptyAccount>) -> Result<()> {
        instructions::reclaim_empty_account::handler(ctx)
    }

    /// M4: Admin market update — update oracle, active status, trading fee.
    pub fn admin_update_market(
        ctx: Context<AdminUpdateMarket>,
        params: AdminUpdateMarketParams,
    ) -> Result<()> {
        instructions::admin_update_market::handler(ctx, params)
    }

    /// M5: Propose admin transfer (current admin only).
    pub fn propose_admin(ctx: Context<ProposeAdmin>, new_admin: Pubkey) -> Result<()> {
        instructions::admin_transfer::handler_propose(ctx, new_admin)
    }

    /// M5: Accept admin transfer (pending admin only).
    pub fn accept_admin(ctx: Context<AcceptAdmin>) -> Result<()> {
        instructions::admin_transfer::handler_accept(ctx)
    }

    /// H1 (R3): Withdraw accumulated SOL creation fees from protocol PDA.
    pub fn admin_withdraw_sol(ctx: Context<AdminWithdrawSol>, amount: u64) -> Result<()> {
        instructions::admin_withdraw_sol::handler(ctx, amount)
    }

    /// Set the default oracle authority (cranker pubkey) on Protocol. Admin only.
    pub fn admin_set_oracle_authority(
        ctx: Context<AdminSetOracleAuthority>,
        new_authority: Pubkey,
    ) -> Result<()> {
        instructions::admin_set_oracle_authority::handler(ctx, new_authority)
    }

    /// Initialize a PerkOracle price feed. Permissionless — anyone can pay rent.
    /// Oracle authority is inherited from Protocol.oracle_authority (set by admin).
    pub fn initialize_perk_oracle(
        ctx: Context<InitializePerkOracle>,
        params: InitPerkOracleParams,
    ) -> Result<()> {
        instructions::initialize_perk_oracle::handler(ctx, params)
    }

    /// Update a PerkOracle price feed. Authorized cranker only.
    pub fn update_perk_oracle(
        ctx: Context<UpdatePerkOracle>,
        params: UpdatePerkOracleParams,
    ) -> Result<()> {
        instructions::update_perk_oracle::handler(ctx, params)
    }

    /// Freeze or unfreeze a PerkOracle. Admin only.
    pub fn freeze_perk_oracle(ctx: Context<FreezePerkOracle>, frozen: bool) -> Result<()> {
        instructions::freeze_perk_oracle::handler(ctx, frozen)
    }

    /// Transfer PerkOracle authority. Current authority only.
    pub fn transfer_oracle_authority(ctx: Context<TransferOracleAuthority>) -> Result<()> {
        instructions::transfer_oracle_authority::handler(ctx)
    }

    /// Set or remove fallback oracle on a market. Admin only.
    pub fn admin_set_fallback_oracle(
        ctx: Context<AdminSetFallbackOracle>,
        params: SetFallbackOracleParams,
    ) -> Result<()> {
        instructions::admin_set_fallback_oracle::handler(ctx, params)
    }

    /// Update PerkOracle config (price banding). Admin only.
    pub fn update_oracle_config(
        ctx: Context<UpdateOracleConfig>,
        params: UpdateOracleConfigParams,
    ) -> Result<()> {
        instructions::update_oracle_config::handler(ctx, params)
    }
}
