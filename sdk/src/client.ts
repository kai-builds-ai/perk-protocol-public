import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  TransactionSignature,
  TransactionInstruction,
  Commitment,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  getAssociatedTokenAddress,
} from "@solana/spl-token";
import { Program, AnchorProvider, Idl, BN, Wallet } from "@coral-xyz/anchor";

import { PERK_PROGRAM_ID, MIN_LEVERAGE, MAX_LEVERAGE, LEVERAGE_SCALE } from "./constants";

// Anchor IDL generates dynamic account namespaces — we cast through `any`
// for account fetching since the IDL types aren't statically known.
type AnyAccounts = Record<string, { fetch: Function; all: Function; fetchNullable: Function }>;
import {
  findProtocolAddress,
  findMarketAddress,
  findPositionAddress,
  findVaultAddress,
  findTriggerOrderAddress,
} from "./pda";
import {
  Side,
  OracleSource,
  CreateMarketParams,
  AdminUpdateMarketParams,
  TriggerOrderType,
  TriggerOrderParams,
  MarketAccount,
  UserPositionAccount,
  ProtocolAccount,
  TriggerOrderAccount,
} from "./types";
import IDL from "./idl.json";

// ── Anchor enum serialization maps ──
const SIDE_MAP = {
  [Side.Long]: { long: {} },
  [Side.Short]: { short: {} },
};

const ORACLE_SOURCE_MAP = {
  [OracleSource.Pyth]: { pyth: {} },
  [OracleSource.DexPool]: { dexPool: {} },
};

const ORDER_TYPE_MAP = {
  [TriggerOrderType.Limit]: { limit: {} },
  [TriggerOrderType.StopLoss]: { stopLoss: {} },
  [TriggerOrderType.TakeProfit]: { takeProfit: {} },
};

export interface PerkClientConfig {
  connection: Connection;
  wallet: Wallet;
  programId?: PublicKey;
  commitment?: Commitment;
  /** Instructions to prepend to every transaction (e.g., ComputeBudget priority fees). */
  preInstructions?: TransactionInstruction[];
}

export class PerkClient {
  readonly connection: Connection;
  readonly wallet: Wallet;
  readonly programId: PublicKey;
  readonly program: Program;
  readonly accounts: AnyAccounts;
  readonly provider: AnchorProvider;
  readonly preInstructions: TransactionInstruction[];

  constructor(config: PerkClientConfig) {
    this.connection = config.connection;
    this.wallet = config.wallet;
    this.programId = config.programId ?? PERK_PROGRAM_ID;
    this.preInstructions = config.preInstructions ?? [];
    this.provider = new AnchorProvider(
      config.connection,
      config.wallet,
      { commitment: config.commitment ?? "confirmed" }
    );
    this.program = new Program(IDL as Idl, this.provider);
    this.accounts = this.program.account as unknown as AnyAccounts;
  }

  // ═══════════════════════════════════════════════
  // PDA Helpers
  // ═══════════════════════════════════════════════

  getProtocolAddress(): PublicKey {
    return findProtocolAddress(this.programId)[0];
  }

  getMarketAddress(tokenMint: PublicKey): PublicKey {
    return findMarketAddress(tokenMint, this.programId)[0];
  }

  getPositionAddress(market: PublicKey, user: PublicKey): PublicKey {
    return findPositionAddress(market, user, this.programId)[0];
  }

  getVaultAddress(market: PublicKey): PublicKey {
    return findVaultAddress(market, this.programId)[0];
  }

  getTriggerOrderAddress(
    market: PublicKey,
    user: PublicKey,
    orderId: number | BN
  ): PublicKey {
    return findTriggerOrderAddress(market, user, orderId, this.programId)[0];
  }

  // ═══════════════════════════════════════════════
  // Account Fetchers
  // ═══════════════════════════════════════════════

  async fetchProtocol(): Promise<ProtocolAccount> {
    const address = this.getProtocolAddress();
    return (await this.accounts.protocol.fetch(
      address
    )) as unknown as ProtocolAccount;
  }

  async fetchMarket(tokenMint: PublicKey): Promise<MarketAccount> {
    const address = this.getMarketAddress(tokenMint);
    return (await this.accounts.market.fetch(
      address
    )) as unknown as MarketAccount;
  }

  async fetchMarketByAddress(address: PublicKey): Promise<MarketAccount> {
    return (await this.accounts.market.fetch(
      address
    )) as unknown as MarketAccount;
  }

  async fetchAllMarkets(): Promise<{ address: PublicKey; account: MarketAccount }[]> {
    const accounts = await this.accounts.market.all();
    return accounts.map((a: any) => ({
      address: a.publicKey,
      account: a.account as unknown as MarketAccount,
    }));
  }

  async fetchPosition(
    market: PublicKey,
    user: PublicKey
  ): Promise<UserPositionAccount> {
    const address = this.getPositionAddress(market, user);
    return (await this.accounts.userPosition.fetch(
      address
    )) as unknown as UserPositionAccount;
  }

  async fetchPositionByAddress(
    address: PublicKey
  ): Promise<UserPositionAccount> {
    return (await this.accounts.userPosition.fetch(
      address
    )) as unknown as UserPositionAccount;
  }

  async fetchAllPositions(
    user: PublicKey
  ): Promise<{ address: PublicKey; account: UserPositionAccount }[]> {
    const accounts = await this.accounts.userPosition.all([
      { memcmp: { offset: 8, bytes: user.toBase58() } },
    ]);
    return accounts.map((a: any) => ({
      address: a.publicKey,
      account: a.account as unknown as UserPositionAccount,
    }));
  }

  async fetchTriggerOrder(address: PublicKey): Promise<TriggerOrderAccount> {
    return (await this.accounts.triggerOrder.fetch(
      address
    )) as unknown as TriggerOrderAccount;
  }

  async fetchTriggerOrders(
    market: PublicKey,
    user: PublicKey
  ): Promise<{ address: PublicKey; account: TriggerOrderAccount }[]> {
    const accounts = await this.accounts.triggerOrder.all([
      { memcmp: { offset: 8, bytes: user.toBase58() } },        // authority at offset 8
      { memcmp: { offset: 8 + 32, bytes: market.toBase58() } }, // market at offset 40
    ]);
    return accounts
      .map((a: any) => ({
        address: a.publicKey,
        account: a.account as unknown as TriggerOrderAccount,
      }));
  }

  // ═══════════════════════════════════════════════
  // Admin Instructions
  // ═══════════════════════════════════════════════

  /** Initialize the protocol (admin only, once). */
  async initializeProtocol(
    protocolFeeVault: PublicKey
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    return this.program.methods
      .initializeProtocol()
      .accounts({
        protocol,
        admin: this.wallet.publicKey,
        protocolFeeVault,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Propose a new admin (current admin only). */
  async proposeAdmin(newAdmin: PublicKey): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    return this.program.methods
      .proposeAdmin(newAdmin)
      .accounts({
        protocol,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Accept admin transfer (pending admin only). */
  async acceptAdmin(): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    return this.program.methods
      .acceptAdmin()
      .accounts({
        protocol,
        newAdmin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Pause/unpause the protocol. */
  async adminPause(paused: boolean): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    return this.program.methods
      .adminPause(paused)
      .accounts({
        protocol,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Update market parameters (admin only). */
  async adminUpdateMarket(
    tokenMint: PublicKey,
    oracle: PublicKey | null,
    params: AdminUpdateMarketParams
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    return this.program.methods
      .adminUpdateMarket(params)
      .accounts({
        protocol,
        market,
        oracle: oracle ?? this.programId, // Anchor optional-absent sentinel
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Withdraw SOL from protocol PDA (admin only). */
  async adminWithdrawSol(amount: BN): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    return this.program.methods
      .adminWithdrawSol(amount)
      .accounts({
        protocol,
        admin: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Market Instructions
  // ═══════════════════════════════════════════════

  /** Create a new perpetual futures market. */
  async createMarket(
    tokenMint: PublicKey,
    oracle: PublicKey,
    params: CreateMarketParams
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const [market] = findMarketAddress(tokenMint, this.programId);
    const [vault] = findVaultAddress(market, this.programId);

    return this.program.methods
      .createMarket({
        oracleSource: ORACLE_SOURCE_MAP[params.oracleSource],
        maxLeverage: params.maxLeverage,
        tradingFeeBps: params.tradingFeeBps,
        initialK: params.initialK,
      })
      .accounts({
        protocol,
        market,
        tokenMint,
        oracle,
        vault,
        creator: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
        rent: SYSVAR_RENT_PUBKEY,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Position Instructions
  // ═══════════════════════════════════════════════

  /** Initialize a position account for a user on a market. */
  async initializePosition(
    tokenMint: PublicKey
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);

    return this.program.methods
      .initializePosition()
      .accounts({
        protocol,
        market,
        userPosition: position,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Deposit collateral into a position. */
  async deposit(
    tokenMint: PublicKey,
    oracle: PublicKey,
    amount: BN
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const [vault] = findVaultAddress(market, this.programId);
    const userAta = await getAssociatedTokenAddress(tokenMint, this.wallet.publicKey);

    return this.program.methods
      .deposit(amount)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        userTokenAccount: userAta,
        vault,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Withdraw collateral from a position. */
  async withdraw(
    tokenMint: PublicKey,
    oracle: PublicKey,
    amount: BN
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const [vault] = findVaultAddress(market, this.programId);
    const userAta = await getAssociatedTokenAddress(tokenMint, this.wallet.publicKey);

    return this.program.methods
      .withdraw(amount)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        userTokenAccount: userAta,
        vault,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Open a leveraged position. */
  async openPosition(
    tokenMint: PublicKey,
    oracle: PublicKey,
    side: Side,
    baseSize: BN,
    leverage: number,
    maxSlippageBps: number = 500
  ): Promise<TransactionSignature> {
    // Input validation — catch bad values before they hit Borsh serialization
    if (leverage < MIN_LEVERAGE || leverage > MAX_LEVERAGE) {
      throw new Error(`leverage must be ${MIN_LEVERAGE}-${MAX_LEVERAGE} (${MIN_LEVERAGE / LEVERAGE_SCALE}x-${MAX_LEVERAGE / LEVERAGE_SCALE}x), got ${leverage}`);
    }
    if (maxSlippageBps < 0 || maxSlippageBps > 65535) {
      throw new Error(`maxSlippageBps must be 0-65535 (u16), got ${maxSlippageBps}`);
    }
    if (!Number.isInteger(leverage) || !Number.isInteger(maxSlippageBps)) {
      throw new Error("leverage and maxSlippageBps must be integers");
    }
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    return this.program.methods
      .openPosition(SIDE_MAP[side], baseSize, leverage, maxSlippageBps)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Close a position (full or partial). */
  async closePosition(
    tokenMint: PublicKey,
    oracle: PublicKey,
    baseSizeToClose?: BN
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);

    return this.program.methods
      .closePosition(baseSizeToClose ?? null)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Trigger Orders
  // ═══════════════════════════════════════════════

  /** Place a trigger order (limit, stop-loss, take-profit). */
  async placeTriggerOrder(
    tokenMint: PublicKey,
    params: TriggerOrderParams
  ): Promise<TransactionSignature> {
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);

    // Fetch position to get next order ID
    const pos = await this.fetchPositionByAddress(position);
    const orderId = pos.nextOrderId;
    const triggerOrder = this.getTriggerOrderAddress(
      market,
      this.wallet.publicKey,
      orderId
    );

    return this.program.methods
      .placeTriggerOrder({
        orderType: ORDER_TYPE_MAP[params.orderType],
        side: SIDE_MAP[params.side],
        size: params.size,
        triggerPrice: params.triggerPrice,
        leverage: params.leverage,
        reduceOnly: params.reduceOnly,
        expiry: params.expiry,
      })
      .accounts({
        market,
        userPosition: position,
        triggerOrder,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Cancel a trigger order. */
  async cancelTriggerOrder(
    tokenMint: PublicKey,
    orderId: number | BN
  ): Promise<TransactionSignature> {
    const market = this.getMarketAddress(tokenMint);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const triggerOrder = this.getTriggerOrderAddress(
      market,
      this.wallet.publicKey,
      orderId
    );

    return this.program.methods
      .cancelTriggerOrder()
      .accounts({
        market,
        userPosition: position,
        triggerOrder,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Fee Claims
  // ═══════════════════════════════════════════════

  /** Claim accumulated fees (creator or protocol). */
  async claimFees(
    tokenMint: PublicKey,
    recipientTokenAccount: PublicKey
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint);
    const [vault] = findVaultAddress(market, this.programId);

    return this.program.methods
      .claimFees()
      .accounts({
        protocol,
        market,
        vault,
        recipientTokenAccount,
        claimer: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Cranker Instructions
  // ═══════════════════════════════════════════════

  /** Crank funding rate update. */
  async crankFunding(
    marketAddress: PublicKey,
    oracle: PublicKey
  ): Promise<TransactionSignature> {
    return this.program.methods
      .crankFunding()
      .accounts({
        market: marketAddress,
        oracle,
        cranker: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Liquidate an underwater position. */
  async liquidate(
    marketAddress: PublicKey,
    oracle: PublicKey,
    targetUser: PublicKey,
    liquidatorTokenAccount: PublicKey
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const position = this.getPositionAddress(marketAddress, targetUser);
    const [vault] = findVaultAddress(marketAddress, this.programId);

    return this.program.methods
      .liquidate()
      .accounts({
        protocol,
        market: marketAddress,
        userPosition: position,
        oracle,
        targetUser,
        liquidatorTokenAccount,
        vault,
        liquidator: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Execute a trigger order that has been triggered. */
  async executeTriggerOrder(
    marketAddress: PublicKey,
    oracle: PublicKey,
    targetUser: PublicKey,
    orderId: number | BN,
    executorTokenAccount: PublicKey
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const position = this.getPositionAddress(marketAddress, targetUser);
    const triggerOrder = this.getTriggerOrderAddress(
      marketAddress,
      targetUser,
      orderId
    );
    const [vault] = findVaultAddress(marketAddress, this.programId);

    return this.program.methods
      .executeTriggerOrder()
      .accounts({
        protocol,
        market: marketAddress,
        userPosition: position,
        triggerOrder,
        oracle,
        executorTokenAccount,
        vault,
        executor: this.wallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Update the vAMM peg multiplier (permissionless). */
  async updateAmm(
    marketAddress: PublicKey,
    oracle: PublicKey
  ): Promise<TransactionSignature> {
    return this.program.methods
      .updateAmm()
      .accounts({
        market: marketAddress,
        oracle,
        caller: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Reclaim an empty/abandoned position account (permissionless). */
  async reclaimEmptyAccount(
    marketAddress: PublicKey,
    oracle: PublicKey,
    positionOwner: PublicKey
  ): Promise<TransactionSignature> {
    const position = this.getPositionAddress(marketAddress, positionOwner);

    return this.program.methods
      .reclaimEmptyAccount()
      .accounts({
        market: marketAddress,
        userPosition: position,
        oracle,
        positionOwner,
        rentReceiver: positionOwner, // On-chain enforces rentReceiver == position.authority
        caller: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }
}
