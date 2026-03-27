import { Connection, PublicKey, Transaction, TransactionSignature, TransactionInstruction, Commitment, SendOptions } from "@solana/web3.js";
import { Program, AnchorProvider, BN, Wallet } from "@coral-xyz/anchor";
type AnyAccounts = Record<string, {
    fetch: Function;
    all: Function;
    fetchNullable: Function;
}>;
import { Side, CreateMarketParams, AdminUpdateMarketParams, TriggerOrderParams, MarketAccount, UserPositionAccount, ProtocolAccount, TriggerOrderAccount, PerkOracleAccount, InitPerkOracleParams, UpdatePerkOracleParams, UpdateOracleConfigParams, SetFallbackOracleParams } from "./types";
/**
 * Optional callback to send transactions via the wallet adapter's
 * `signAndSendTransaction` flow (preferred by Phantom/Blowfish).
 * Signature matches `useWallet().sendTransaction` from @solana/wallet-adapter-react.
 */
export type SendTransactionFn = (transaction: Transaction, connection: Connection, options?: SendOptions) => Promise<TransactionSignature>;
export interface PerkClientConfig {
    connection: Connection;
    wallet: Wallet;
    programId?: PublicKey;
    commitment?: Commitment;
    /** Instructions to prepend to every transaction (e.g., ComputeBudget priority fees). */
    preInstructions?: TransactionInstruction[];
    /**
     * When provided, transactions are sent via this callback instead of
     * Anchor's default `signTransaction` + `sendRawTransaction` flow.
     * Pass `wallet.sendTransaction` from @solana/wallet-adapter-react
     * so Phantom uses `signAndSendTransaction` internally.
     */
    sendTransaction?: SendTransactionFn;
}
export declare class PerkClient {
    readonly connection: Connection;
    readonly wallet: Wallet;
    readonly programId: PublicKey;
    readonly program: Program;
    readonly accounts: AnyAccounts;
    readonly provider: AnchorProvider;
    readonly preInstructions: TransactionInstruction[];
    constructor(config: PerkClientConfig);
    getProtocolAddress(): PublicKey;
    getMarketAddress(tokenMint: PublicKey, creator: PublicKey): PublicKey;
    getPositionAddress(market: PublicKey, user: PublicKey): PublicKey;
    getVaultAddress(market: PublicKey): PublicKey;
    getTriggerOrderAddress(market: PublicKey, user: PublicKey, orderId: number | BN): PublicKey;
    getPerkOracleAddress(tokenMint: PublicKey): PublicKey;
    fetchProtocol(): Promise<ProtocolAccount>;
    fetchMarket(tokenMint: PublicKey, creator: PublicKey): Promise<MarketAccount>;
    fetchMarketByAddress(address: PublicKey): Promise<MarketAccount>;
    fetchAllMarkets(): Promise<{
        address: PublicKey;
        account: MarketAccount;
    }[]>;
    fetchPosition(market: PublicKey, user: PublicKey): Promise<UserPositionAccount>;
    fetchPositionByAddress(address: PublicKey): Promise<UserPositionAccount>;
    fetchAllPositions(user: PublicKey): Promise<{
        address: PublicKey;
        account: UserPositionAccount;
    }[]>;
    fetchTriggerOrder(address: PublicKey): Promise<TriggerOrderAccount>;
    fetchTriggerOrders(market: PublicKey, user: PublicKey): Promise<{
        address: PublicKey;
        account: TriggerOrderAccount;
    }[]>;
    /** Fetch a PerkOracle account. */
    fetchPerkOracle(tokenMint: PublicKey): Promise<PerkOracleAccount>;
    /** Fetch a PerkOracle account, returning null if not found. */
    fetchPerkOracleNullable(tokenMint: PublicKey): Promise<PerkOracleAccount | null>;
    /** Fetch all PerkOracle accounts on-chain. */
    fetchAllPerkOracles(): Promise<{
        address: PublicKey;
        account: PerkOracleAccount;
    }[]>;
    /** Initialize the protocol (admin only, once). */
    initializeProtocol(protocolFeeVault: PublicKey): Promise<TransactionSignature>;
    /** Propose a new admin (current admin only). */
    proposeAdmin(newAdmin: PublicKey): Promise<TransactionSignature>;
    /** Accept admin transfer (pending admin only). */
    acceptAdmin(): Promise<TransactionSignature>;
    /** Pause/unpause the protocol. */
    adminPause(paused: boolean): Promise<TransactionSignature>;
    /** Update market parameters (admin only). */
    adminUpdateMarket(tokenMint: PublicKey, creator: PublicKey, oracle: PublicKey | null, params: AdminUpdateMarketParams): Promise<TransactionSignature>;
    /** Withdraw SOL from protocol PDA (admin only). */
    adminWithdrawSol(amount: BN): Promise<TransactionSignature>;
    /** Create a new perpetual futures market. */
    createMarket(tokenMint: PublicKey, oracle: PublicKey, params: CreateMarketParams): Promise<TransactionSignature>;
    /** Initialize a position account for a user on a market. */
    initializePosition(tokenMint: PublicKey, creator: PublicKey): Promise<TransactionSignature>;
    /** Deposit collateral into a position. */
    deposit(tokenMint: PublicKey, creator: PublicKey, oracle: PublicKey, amount: BN, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Withdraw collateral from a position. */
    withdraw(tokenMint: PublicKey, creator: PublicKey, oracle: PublicKey, amount: BN, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Open a leveraged position. */
    openPosition(tokenMint: PublicKey, creator: PublicKey, oracle: PublicKey, side: Side, baseSize: BN, leverage: number, maxSlippageBps?: number, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Close a position (full or partial). */
    closePosition(tokenMint: PublicKey, creator: PublicKey, oracle: PublicKey, baseSizeToClose?: BN, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Place a trigger order (limit, stop-loss, take-profit). */
    placeTriggerOrder(tokenMint: PublicKey, creator: PublicKey, params: TriggerOrderParams): Promise<TransactionSignature>;
    /** Cancel a trigger order. */
    cancelTriggerOrder(tokenMint: PublicKey, creator: PublicKey, orderId: number | BN): Promise<TransactionSignature>;
    /** Claim accumulated fees (creator or protocol). */
    claimFees(tokenMint: PublicKey, creator: PublicKey, recipientTokenAccount: PublicKey): Promise<TransactionSignature>;
    /** Crank funding rate update. */
    crankFunding(marketAddress: PublicKey, oracle: PublicKey, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Liquidate an underwater position. */
    liquidate(marketAddress: PublicKey, oracle: PublicKey, targetUser: PublicKey, liquidatorTokenAccount: PublicKey, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Execute a trigger order that has been triggered. */
    executeTriggerOrder(marketAddress: PublicKey, oracle: PublicKey, targetUser: PublicKey, orderId: number | BN, executorTokenAccount: PublicKey, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Update the vAMM peg multiplier (permissionless). */
    updateAmm(marketAddress: PublicKey, oracle: PublicKey, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Reclaim an empty/abandoned position account (permissionless). */
    reclaimEmptyAccount(marketAddress: PublicKey, oracle: PublicKey, positionOwner: PublicKey, fallbackOracle?: PublicKey): Promise<TransactionSignature>;
    /** Initialize a PerkOracle price feed. Admin only. */
    initializePerkOracle(tokenMint: PublicKey, oracleAuthority: PublicKey, params: InitPerkOracleParams): Promise<TransactionSignature>;
    /** Update a PerkOracle price feed. Authorized cranker only. */
    updatePerkOracle(tokenMint: PublicKey, params: UpdatePerkOracleParams): Promise<TransactionSignature>;
    /** Build updatePerkOracle instructions without sending. Used for Jito bundle submission. */
    buildUpdatePerkOracleIx(tokenMint: PublicKey, params: UpdatePerkOracleParams): Promise<TransactionInstruction[]>;
    /** Freeze or unfreeze a PerkOracle. Admin only. */
    freezePerkOracle(tokenMint: PublicKey, frozen: boolean): Promise<TransactionSignature>;
    /** Transfer PerkOracle authority. Current authority or admin. */
    transferOracleAuthority(tokenMint: PublicKey, newAuthority: PublicKey): Promise<TransactionSignature>;
    /** Update PerkOracle config (price banding). Admin only. */
    updateOracleConfig(tokenMint: PublicKey, params: UpdateOracleConfigParams): Promise<TransactionSignature>;
    /** Set or remove fallback oracle on a market. Admin only. */
    adminSetFallbackOracle(tokenMint: PublicKey, creator: PublicKey, params: SetFallbackOracleParams): Promise<TransactionSignature>;
}
export {};
//# sourceMappingURL=client.d.ts.map