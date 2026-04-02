import {
  Connection,
  PublicKey,
  SystemProgram,
  SYSVAR_RENT_PUBKEY,
  Transaction,
  TransactionSignature,
  TransactionInstruction,
  Commitment,
  SendOptions,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
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
  findPerkOracleAddress,
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
  PerkOracleAccount,
  InitPerkOracleParams,
  UpdatePerkOracleParams,
  UpdateOracleConfigParams,
  SetFallbackOracleParams,
} from "./types";
import IDL from "./idl.json";

// ── Anchor enum serialization maps ──
const SIDE_MAP = {
  [Side.Long]: { long: {} },
  [Side.Short]: { short: {} },
};

const ORACLE_SOURCE_MAP = {
  [OracleSource.Pyth]: { pyth: {} },
  [OracleSource.PerkOracle]: { perkOracle: {} },
  [OracleSource.DexPool]: { dexPool: {} },
};

const ORDER_TYPE_MAP = {
  [TriggerOrderType.Limit]: { limit: {} },
  [TriggerOrderType.StopLoss]: { stopLoss: {} },
  [TriggerOrderType.TakeProfit]: { takeProfit: {} },
};

/**
 * Optional callback to send transactions via the wallet adapter's
 * `signAndSendTransaction` flow (preferred by Phantom/Blowfish).
 * Signature matches `useWallet().sendTransaction` from @solana/wallet-adapter-react.
 */
export type SendTransactionFn = (
  transaction: Transaction,
  connection: Connection,
  options?: SendOptions,
) => Promise<TransactionSignature>;

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

/**
 * AnchorProvider subclass that routes transaction sending through the
 * wallet adapter's `sendTransaction` (which uses `signAndSendTransaction`
 * on wallets that support it, like Phantom). This avoids the
 * `signTransaction` + `sendRawTransaction` pattern that Blowfish/Phantom
 * flag as potentially unsafe.
 */
class WalletAdapterProvider extends AnchorProvider {
  private _sendTx: SendTransactionFn;

  constructor(
    connection: Connection,
    wallet: Wallet,
    opts: { commitment?: Commitment },
    sendTx: SendTransactionFn,
  ) {
    super(connection, wallet, opts);
    this._sendTx = sendTx;
  }

  override async sendAndConfirm(
    tx: Transaction,
    signers?: Array<{ publicKey: PublicKey; secretKey: Uint8Array }>,
    opts?: { commitment?: Commitment; skipPreflight?: boolean },
  ): Promise<TransactionSignature> {
    // Partial-sign with any extra signers (e.g., new keypairs for PDAs)
    if (signers?.length) {
      tx.partialSign(...(signers as any));
    }

    const commitment = opts?.commitment ?? this.opts.commitment ?? "confirmed";

    // Always fetch a fresh blockhash right before signing — Anchor or earlier code
    // may have set a stale one. This guarantees maximum validity window.
    const bh = await this.connection.getLatestBlockhash(commitment);
    tx.recentBlockhash = bh.blockhash;
    tx.lastValidBlockHeight = bh.lastValidBlockHeight;
    tx.feePayer = this.wallet.publicKey;

    // Sign via wallet (Phantom popup) — do NOT use sendTransaction which routes
    // through Phantom's own RPC. We want to send through OUR Helius connection
    // so send + confirm use the same RPC view.
    const signed = await this.wallet.signTransaction(tx);

    // Send through our RPC connection directly
    const sig = await this.connection.sendRawTransaction(signed.serialize(), {
      skipPreflight: opts?.skipPreflight ?? false,
      preflightCommitment: commitment,
      maxRetries: 3,
    });

    // Confirm using the TX's original blockhash (same validity window)
    const confirmation = await this.connection.confirmTransaction(
      {
        signature: sig,
        blockhash: tx.recentBlockhash!,
        lastValidBlockHeight: tx.lastValidBlockHeight!,
      },
      commitment,
    );

    if (confirmation.value.err) {
      throw new Error(
        `Transaction confirmed but failed on-chain: ${JSON.stringify(confirmation.value.err)} [sig: ${sig}]`
      );
    }

    return sig;
  }
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

    // Use WalletAdapterProvider when sendTransaction is provided (frontend),
    // fall back to standard AnchorProvider (cranker/scripts with keypairs).
    const opts = { commitment: config.commitment ?? "confirmed" };
    this.provider = config.sendTransaction
      ? new WalletAdapterProvider(config.connection, config.wallet, opts, config.sendTransaction)
      : new AnchorProvider(config.connection, config.wallet, opts);

    this.program = new Program(IDL as Idl, this.provider);
    this.accounts = this.program.account as unknown as AnyAccounts;
  }

  // ═══════════════════════════════════════════════
  // PDA Helpers
  // ═══════════════════════════════════════════════

  /**
   * Detect whether a mint is SPL Token or Token-2022 by checking the account owner.
   * Returns the correct token program ID and ATA for the given mint + owner.
   */
  async getTokenProgramForMint(mint: PublicKey): Promise<PublicKey> {
    const info = await this.connection.getAccountInfo(mint);
    if (!info) throw new Error(`Mint account not found: ${mint.toBase58()}`);
    if (info.owner.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
    return TOKEN_PROGRAM_ID;
  }

  getProtocolAddress(): PublicKey {
    return findProtocolAddress(this.programId)[0];
  }

  getMarketAddress(tokenMint: PublicKey, creator: PublicKey): PublicKey {
    return findMarketAddress(tokenMint, creator, this.programId)[0];
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

  getPerkOracleAddress(tokenMint: PublicKey): PublicKey {
    return findPerkOracleAddress(tokenMint, this.programId)[0];
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

  async fetchMarket(tokenMint: PublicKey, creator: PublicKey): Promise<MarketAccount> {
    const address = this.getMarketAddress(tokenMint, creator);
    return (await this.accounts.market.fetch(
      address
    )) as unknown as MarketAccount;
  }

  async fetchMarketByAddress(address: PublicKey): Promise<MarketAccount> {
    return (await this.accounts.market.fetch(
      address
    )) as unknown as MarketAccount;
  }

  /** Get the collateral mint for a market (reads from on-chain state). */
  async getCollateralMint(tokenMint: PublicKey, creator: PublicKey): Promise<PublicKey> {
    const market = await this.fetchMarket(tokenMint, creator);
    return market.collateralMint;
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

  /** Fetch a PerkOracle account. */
  async fetchPerkOracle(tokenMint: PublicKey): Promise<PerkOracleAccount> {
    const address = this.getPerkOracleAddress(tokenMint);
    return (await this.accounts.perkOraclePrice.fetch(address)) as unknown as PerkOracleAccount;
  }

  /** Fetch a PerkOracle account, returning null if not found. */
  async fetchPerkOracleNullable(tokenMint: PublicKey): Promise<PerkOracleAccount | null> {
    const address = this.getPerkOracleAddress(tokenMint);
    return (await this.accounts.perkOraclePrice.fetchNullable(address)) as unknown as PerkOracleAccount | null;
  }

  /** Fetch all PerkOracle accounts on-chain. */
  async fetchAllPerkOracles(): Promise<{ address: PublicKey; account: PerkOracleAccount }[]> {
    const raw = await this.accounts.perkOraclePrice.all();
    return raw.map((r: { publicKey: PublicKey; account: unknown }) => ({
      address: r.publicKey,
      account: r.account as PerkOracleAccount,
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
    creator: PublicKey,
    oracle: PublicKey | null,
    params: AdminUpdateMarketParams,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
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

  /** Create a new perpetual futures market.
   *  collateralMint must be a 6-decimal token (USDC, USDT, etc.) */
  async createMarket(
    tokenMint: PublicKey,
    oracle: PublicKey,
    params: CreateMarketParams,
    collateralMint: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const [market] = findMarketAddress(tokenMint, this.wallet.publicKey, this.programId);
    const [vault] = findVaultAddress(market, this.programId);
    // Known collateral mints are all standard SPL Token — skip the RPC lookup
    // to avoid mobile wallet failures from flaky getAccountInfo calls
    const KNOWN_SPL_MINTS = [
      "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", // USDC
      "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", // USDT
      "2b1kV6DkPAnxd5ixfnxCpjxmKwqjjaYmCZfHsFu24GXo", // PYUSD
    ];
    const tokenProgramId = KNOWN_SPL_MINTS.includes(collateralMint.toBase58())
      ? TOKEN_PROGRAM_ID
      : await this.getTokenProgramForMint(collateralMint);

    const accounts = {
      protocol,
      market,
      tokenMint,
      collateralMint,
      oracle,
      vault,
      creator: this.wallet.publicKey,
      systemProgram: SystemProgram.programId,
      tokenProgram: tokenProgramId,
      rent: SYSVAR_RENT_PUBKEY,
    };
    console.log('[createMarket] accounts:', Object.fromEntries(
      Object.entries(accounts).map(([k, v]) => [k, v.toBase58()])
    ));
    console.log('[createMarket] params:', {
      oracleSource: ORACLE_SOURCE_MAP[params.oracleSource],
      maxLeverage: params.maxLeverage,
      tradingFeeBps: params.tradingFeeBps,
      initialK: params.initialK.toString(),
    });
    return this.program.methods
      .createMarket({
        oracleSource: ORACLE_SOURCE_MAP[params.oracleSource],
        maxLeverage: params.maxLeverage,
        tradingFeeBps: params.tradingFeeBps,
        initialK: params.initialK,
      })
      .accounts(accounts)
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Position Instructions
  // ═══════════════════════════════════════════════

  /** Initialize a position account for a user on a market. */
  async initializePosition(
    tokenMint: PublicKey,
    creator: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
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
    creator: PublicKey,
    oracle: PublicKey,
    amount: BN,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const [vault] = findVaultAddress(market, this.programId);
    const collateralMint = await this.getCollateralMint(tokenMint, creator);
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);
    const userAta = await getAssociatedTokenAddress(collateralMint, this.wallet.publicKey, false, tokenProgramId);

    return this.program.methods
      .deposit(amount)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        collateralMint,
        userTokenAccount: userAta,
        vault,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: tokenProgramId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Withdraw collateral from a position. */
  async withdraw(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    amount: BN,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const [vault] = findVaultAddress(market, this.programId);
    const collateralMint = await this.getCollateralMint(tokenMint, creator);
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);
    const userAta = await getAssociatedTokenAddress(collateralMint, this.wallet.publicKey, false, tokenProgramId);

    return this.program.methods
      .withdraw(amount)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        collateralMint,
        userTokenAccount: userAta,
        vault,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
        tokenProgram: tokenProgramId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Open a leveraged position. */
  async openPosition(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    side: Side,
    baseSize: BN,
    leverage: number,
    maxSlippageBps: number = 500,
    fallbackOracle?: PublicKey,
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
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    return this.program.methods
      .openPosition(SIDE_MAP[side], baseSize, leverage, maxSlippageBps)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Close a position (full or partial). */
  async closePosition(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    baseSizeToClose?: BN,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);

    return this.program.methods
      .closePosition(baseSizeToClose ?? null)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Instruction Builders (for composing multi-IX transactions)
  // ═══════════════════════════════════════════════

  /** Build an initializePosition instruction without sending. */
  async buildInitializePositionIx(
    tokenMint: PublicKey,
    creator: PublicKey,
  ): Promise<TransactionInstruction> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
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
      .instruction();
  }

  /** Build a deposit instruction without sending. */
  async buildDepositIx(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    amount: BN,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionInstruction> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const [vault] = findVaultAddress(market, this.programId);
    const collateralMint = await this.getCollateralMint(tokenMint, creator);
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);
    const userAta = await getAssociatedTokenAddress(collateralMint, this.wallet.publicKey, false, tokenProgramId);

    return this.program.methods
      .deposit(amount)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        collateralMint,
        userTokenAccount: userAta,
        vault,
        user: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
        tokenProgram: tokenProgramId,
      })
      .instruction();
  }

  /** Build an openPosition instruction without sending. */
  async buildOpenPositionIx(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    side: Side,
    baseSize: BN,
    leverage: number,
    maxSlippageBps: number = 500,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionInstruction> {
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
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    return this.program.methods
      .openPosition(SIDE_MAP[side], baseSize, leverage, maxSlippageBps)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .instruction();
  }

  /** Build a closePosition instruction without sending. */
  async buildClosePositionIx(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    baseSizeToClose?: BN,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionInstruction> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);

    return this.program.methods
      .closePosition(baseSizeToClose ?? null)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .instruction();
  }

  /** Build a withdraw instruction without sending. */
  async buildWithdrawIx(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    amount: BN,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionInstruction> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);
    const [vault] = findVaultAddress(market, this.programId);
    const collateralMint = await this.getCollateralMint(tokenMint, creator);
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);
    const userAta = await getAssociatedTokenAddress(collateralMint, this.wallet.publicKey, false, tokenProgramId);

    return this.program.methods
      .withdraw(amount)
      .accounts({
        protocol,
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        collateralMint,
        userTokenAccount: userAta,
        vault,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
        tokenProgram: tokenProgramId,
      })
      .instruction();
  }

  // ═══════════════════════════════════════════════
  // Trigger Orders
  // ═══════════════════════════════════════════════

  /** Place a trigger order (limit, stop-loss, take-profit). */
  async placeTriggerOrder(
    tokenMint: PublicKey,
    creator: PublicKey,
    params: TriggerOrderParams
  ): Promise<TransactionSignature> {
    const market = this.getMarketAddress(tokenMint, creator);
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
    creator: PublicKey,
    orderId: number | BN
  ): Promise<TransactionSignature> {
    const market = this.getMarketAddress(tokenMint, creator);
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
    creator: PublicKey,
    recipientTokenAccount: PublicKey
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    const [vault] = findVaultAddress(market, this.programId);
    const collateralMint = await this.getCollateralMint(tokenMint, creator);
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);

    return this.program.methods
      .claimFees()
      .accounts({
        protocol,
        market,
        collateralMint,
        vault,
        recipientTokenAccount,
        claimer: this.wallet.publicKey,
        tokenProgram: tokenProgramId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // Cranker Instructions
  // ═══════════════════════════════════════════════

  /** Crank funding rate update. */
  async crankFunding(
    marketAddress: PublicKey,
    oracle: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    return this.program.methods
      .crankFunding()
      .accounts({
        market: marketAddress,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        cranker: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Liquidate an underwater position. */
  async liquidate(
    marketAddress: PublicKey,
    tokenMint: PublicKey,
    oracle: PublicKey,
    targetUser: PublicKey,
    liquidatorTokenAccount: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const position = this.getPositionAddress(marketAddress, targetUser);
    const [vault] = findVaultAddress(marketAddress, this.programId);
    const marketData = await this.fetchMarketByAddress(marketAddress);
    const collateralMint = marketData.collateralMint;
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);

    return this.program.methods
      .liquidate()
      .accounts({
        protocol,
        market: marketAddress,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        targetUser,
        collateralMint,
        liquidatorTokenAccount,
        vault,
        liquidator: this.wallet.publicKey,
        tokenProgram: tokenProgramId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Execute a trigger order that has been triggered. */
  async executeTriggerOrder(
    marketAddress: PublicKey,
    tokenMint: PublicKey,
    oracle: PublicKey,
    targetUser: PublicKey,
    orderId: number | BN,
    executorTokenAccount: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const position = this.getPositionAddress(marketAddress, targetUser);
    const triggerOrder = this.getTriggerOrderAddress(
      marketAddress,
      targetUser,
      orderId
    );
    const [vault] = findVaultAddress(marketAddress, this.programId);
    const marketData = await this.fetchMarketByAddress(marketAddress);
    const collateralMint = marketData.collateralMint;
    const tokenProgramId = await this.getTokenProgramForMint(collateralMint);

    return this.program.methods
      .executeTriggerOrder()
      .accounts({
        protocol,
        market: marketAddress,
        userPosition: position,
        triggerOrder,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        collateralMint,
        executorTokenAccount,
        vault,
        executor: this.wallet.publicKey,
        tokenProgram: tokenProgramId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Update the vAMM peg multiplier (permissionless). */
  async updateAmm(
    marketAddress: PublicKey,
    oracle: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    return this.program.methods
      .updateAmm()
      .accounts({
        market: marketAddress,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        caller: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Build an updateAmm instruction without sending (for TX composition). */
  buildUpdateAmmIx(
    marketAddress: PublicKey,
    oracle: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionInstruction> {
    return this.program.methods
      .updateAmm()
      .accounts({
        market: marketAddress,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        caller: this.wallet.publicKey,
      })
      .instruction();
  }

  /** Reclaim an empty/abandoned position account (permissionless). */
  async reclaimEmptyAccount(
    marketAddress: PublicKey,
    oracle: PublicKey,
    positionOwner: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const position = this.getPositionAddress(marketAddress, positionOwner);

    return this.program.methods
      .reclaimEmptyAccount()
      .accounts({
        market: marketAddress,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        positionOwner,
        rentReceiver: positionOwner, // On-chain enforces rentReceiver == position.authority
        caller: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  // ═══════════════════════════════════════════════
  // PerkOracle Instructions
  // ═══════════════════════════════════════════════

  /** Set oracle authority on Protocol. Admin only — one-time setup. */
  async adminSetOracleAuthority(
    newAuthority: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    return this.program.methods
      .adminSetOracleAuthority(newAuthority)
      .accounts({
        protocol,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Fix a market whose accrue state was never initialized.
   *  Closes the phantom slot gap that causes catastrophic K-coefficient accumulation. */
  async adminFixMarketAccrue(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    return this.program.methods
      .adminFixMarketAccrue()
      .accounts({
        protocol,
        market,
        oracleAccount: oracle,
        fallbackOracle: fallbackOracle || oracle,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Reset K indices on a market with zero open interest.
   *  Zeroes long_k_index, short_k_index, long_epoch_start_k, short_epoch_start_k.
   *  Rejects if any open positions exist. */
  async adminResetKIndices(
    tokenMint: PublicKey,
    creator: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    return this.program.methods
      .adminResetKIndices()
      .accounts({
        protocol,
        market,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Settle accrued funding PnL into collateral without closing the position.
   *  Credits matured profit (or deducts losses) to deposited_collateral. */
  async settleFunding(
    tokenMint: PublicKey,
    creator: PublicKey,
    oracle: PublicKey,
    fallbackOracle?: PublicKey,
  ): Promise<TransactionSignature> {
    const market = this.getMarketAddress(tokenMint, creator);
    const position = this.getPositionAddress(market, this.wallet.publicKey);

    return this.program.methods
      .settleFunding()
      .accounts({
        market,
        userPosition: position,
        oracle,
        fallbackOracle: fallbackOracle ?? SystemProgram.programId,
        authority: this.wallet.publicKey,
        user: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Permissionless: Settle a stale position's side effects.
   *  Unblocks market sides stuck in ResetPending after ADL. */
  async settleStalePosition(
    tokenMint: PublicKey,
    creator: PublicKey,
    positionOwner: PublicKey,
    oracleAddress: PublicKey,
    fallbackOracleAddress?: PublicKey,
  ): Promise<TransactionSignature> {
    const market = this.getMarketAddress(tokenMint, creator);
    const [userPosition] = PublicKey.findProgramAddressSync(
      [Buffer.from("position"), market.toBuffer(), positionOwner.toBuffer()],
      this.programId,
    );
    return this.program.methods
      .settleStalePosition()
      .accounts({
        market,
        userPosition,
        oracle: oracleAddress,
        fallbackOracle: fallbackOracleAddress ?? this.wallet.publicKey,
        positionOwner,
        caller: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Admin-only: Override the side state on a market.
   *  side: 0 = long, 1 = short
   *  state: 0 = Normal, 1 = DrainOnly, 2 = ResetPending */
  async adminSetSideState(
    tokenMint: PublicKey,
    creator: PublicKey,
    side: number,
    state: number,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);
    return this.program.methods
      .adminSetSideState({ side, state })
      .accounts({
        protocol,
        market,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Initialize a PerkOracle price feed. Permissionless — anyone pays rent.
   *  Oracle authority is inherited from Protocol.oracle_authority. */
  async initializePerkOracle(
    tokenMint: PublicKey,
    params: InitPerkOracleParams,
  ): Promise<TransactionSignature> {
    // ── Client-side validation (ATK-01) ──
    // Type safety: reject NaN, Infinity, floats
    for (const [name, val] of Object.entries({
      circuitBreakerDeviationBps: params.circuitBreakerDeviationBps,
      maxPriceChangeBps: params.maxPriceChangeBps,
      minSources: params.minSources,
      maxStalenessSeconds: params.maxStalenessSeconds,
    })) {
      if (!Number.isFinite(val) || !Number.isInteger(val)) {
        throw new Error(`${name} must be a finite integer, got ${val}`);
      }
    }
    // u16 range checks
    if (params.circuitBreakerDeviationBps < 0 || params.circuitBreakerDeviationBps > 65535) {
      throw new Error(`circuitBreakerDeviationBps out of u16 range`);
    }
    if (params.maxPriceChangeBps < 0 || params.maxPriceChangeBps > 65535) {
      throw new Error(`maxPriceChangeBps out of u16 range`);
    }
    // Bounds checks
    if (params.circuitBreakerDeviationBps !== 0) {
      if (params.circuitBreakerDeviationBps < 500 || params.circuitBreakerDeviationBps > 9999) {
        throw new Error(`circuitBreakerDeviationBps must be 0 (disabled) or between 500 and 9999, got ${params.circuitBreakerDeviationBps}`);
      }
    }
    if (params.maxPriceChangeBps !== 0) {
      if (params.maxPriceChangeBps < 100 || params.maxPriceChangeBps > 9999) {
        throw new Error(`maxPriceChangeBps must be 0 (disabled) or between 100 and 9999, got ${params.maxPriceChangeBps}`);
      }
    }
    if (params.minSources < 1 || params.minSources > 10) {
      throw new Error(`minSources must be between 1 and 10, got ${params.minSources}`);
    }
    if (params.maxStalenessSeconds < 5 || params.maxStalenessSeconds > 300) {
      throw new Error(`maxStalenessSeconds must be between 5 and 300, got ${params.maxStalenessSeconds}`);
    }

    const protocol = this.getProtocolAddress();
    const perkOracle = this.getPerkOracleAddress(tokenMint);

    return this.program.methods
      .initializePerkOracle({
        minSources: params.minSources,
        maxStalenessSeconds: params.maxStalenessSeconds,
        maxPriceChangeBps: params.maxPriceChangeBps,
        circuitBreakerDeviationBps: params.circuitBreakerDeviationBps,
      })
      .accounts({
        protocol,
        perkOracle,
        tokenMint,
        payer: this.wallet.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Update a PerkOracle price feed. Authorized cranker only. */
  async updatePerkOracle(
    tokenMint: PublicKey,
    params: UpdatePerkOracleParams,
  ): Promise<TransactionSignature> {
    const perkOracle = this.getPerkOracleAddress(tokenMint);

    return this.program.methods
      .updatePerkOracle({
        price: params.price,
        confidence: params.confidence,
        numSources: params.numSources,
      })
      .accounts({
        perkOracle,
        authority: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Build updatePerkOracle instructions without sending. Used for Jito bundle submission. */
  async buildUpdatePerkOracleIx(
    tokenMint: PublicKey,
    params: UpdatePerkOracleParams,
  ): Promise<TransactionInstruction[]> {
    const perkOracle = this.getPerkOracleAddress(tokenMint);

    const mainIx = await this.program.methods
      .updatePerkOracle({
        price: params.price,
        confidence: params.confidence,
        numSources: params.numSources,
      })
      .accounts({
        perkOracle,
        authority: this.wallet.publicKey,
      })
      .instruction();

    return [...this.preInstructions, mainIx];
  }

  /** Freeze or unfreeze a PerkOracle. Admin only. */
  async freezePerkOracle(
    tokenMint: PublicKey,
    frozen: boolean,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const perkOracle = this.getPerkOracleAddress(tokenMint);

    return this.program.methods
      .freezePerkOracle(frozen)
      .accounts({
        protocol,
        perkOracle,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Transfer PerkOracle authority. Current authority or admin. */
  async transferOracleAuthority(
    tokenMint: PublicKey,
    newAuthority: PublicKey,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const perkOracle = this.getPerkOracleAddress(tokenMint);

    return this.program.methods
      .transferOracleAuthority()
      .accounts({
        protocol,
        perkOracle,
        signer: this.wallet.publicKey,
        newAuthority,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Update PerkOracle config (price banding). Admin only. */
  async updateOracleConfig(
    tokenMint: PublicKey,
    params: UpdateOracleConfigParams,
  ): Promise<TransactionSignature> {
    // ── Client-side validation (ATK-01) ──
    // Type safety: reject NaN, Infinity, floats for non-null fields
    for (const [name, val] of Object.entries(params)) {
      if (val !== null && typeof val === 'number' && (!Number.isFinite(val) || !Number.isInteger(val))) {
        throw new Error(`${name} must be null or a finite integer, got ${val}`);
      }
    }
    // u16 range checks
    if (params.circuitBreakerDeviationBps !== null) {
      if (params.circuitBreakerDeviationBps < 0 || params.circuitBreakerDeviationBps > 65535) {
        throw new Error(`circuitBreakerDeviationBps out of u16 range`);
      }
    }
    if (params.maxPriceChangeBps !== null) {
      if (params.maxPriceChangeBps < 0 || params.maxPriceChangeBps > 65535) {
        throw new Error(`maxPriceChangeBps out of u16 range`);
      }
    }
    // Bounds checks
    if (params.circuitBreakerDeviationBps !== null && params.circuitBreakerDeviationBps !== 0) {
      if (params.circuitBreakerDeviationBps < 500 || params.circuitBreakerDeviationBps > 9999) {
        throw new Error(`circuitBreakerDeviationBps must be 0, null, or between 500 and 9999`);
      }
    }
    if (params.maxPriceChangeBps !== null && params.maxPriceChangeBps !== 0) {
      if (params.maxPriceChangeBps < 100 || params.maxPriceChangeBps > 9999) {
        throw new Error(`maxPriceChangeBps must be 0, null, or between 100 and 9999`);
      }
    }
    if (params.minSources !== null) {
      if (params.minSources < 1 || params.minSources > 10) {
        throw new Error(`minSources must be null or between 1 and 10`);
      }
    }
    if (params.maxStalenessSeconds !== null) {
      if (params.maxStalenessSeconds < 5 || params.maxStalenessSeconds > 300) {
        throw new Error(`maxStalenessSeconds must be null or between 5 and 300`);
      }
    }
    if (params.maxConfidenceBps !== null && params.maxConfidenceBps !== undefined) {
      if (params.maxConfidenceBps < 0 || params.maxConfidenceBps > 65535) {
        throw new Error(`maxConfidenceBps out of u16 range`);
      }
      if (params.maxConfidenceBps !== 0 && (params.maxConfidenceBps < 50 || params.maxConfidenceBps > 2000)) {
        throw new Error(`maxConfidenceBps must be 0, null, or between 50 and 2000`);
      }
    }

    const protocol = this.getProtocolAddress();
    const perkOracle = this.getPerkOracleAddress(tokenMint);

    return this.program.methods
      .updateOracleConfig({
        maxPriceChangeBps: params.maxPriceChangeBps,
        minSources: params.minSources,
        maxStalenessSeconds: params.maxStalenessSeconds,
        circuitBreakerDeviationBps: params.circuitBreakerDeviationBps,
        maxConfidenceBps: params.maxConfidenceBps ?? null,
      })
      .accounts({
        protocol,
        perkOracle,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }

  /** Set or remove fallback oracle on a market. Admin only. */
  async adminSetFallbackOracle(
    tokenMint: PublicKey,
    creator: PublicKey,
    params: SetFallbackOracleParams,
  ): Promise<TransactionSignature> {
    const protocol = this.getProtocolAddress();
    const market = this.getMarketAddress(tokenMint, creator);

    // When removing fallback (address = default/zeros), pass SystemProgram as the
    // account since Solana won't accept the null address as a transaction account.
    // The on-chain handler checks params.fallback_oracle_address == default and
    // short-circuits before reading the account, so the sentinel is never dereferenced.
    const isRemoving = params.fallbackOracleAddress.equals(PublicKey.default);
    const fallbackAccount = isRemoving
      ? SystemProgram.programId
      : params.fallbackOracleAddress;

    return this.program.methods
      .adminSetFallbackOracle({
        fallbackOracleSource: ORACLE_SOURCE_MAP[params.fallbackOracleSource],
        fallbackOracleAddress: params.fallbackOracleAddress,
      })
      .accounts({
        protocol,
        market,
        fallbackOracle: fallbackAccount,
        admin: this.wallet.publicKey,
      })
      .preInstructions(this.preInstructions).rpc();
  }
}
