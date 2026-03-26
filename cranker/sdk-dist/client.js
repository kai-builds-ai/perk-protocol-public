"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.PerkClient = void 0;
const web3_js_1 = require("@solana/web3.js");
const spl_token_1 = require("@solana/spl-token");
const anchor_1 = require("@coral-xyz/anchor");
const constants_1 = require("./constants");
const pda_1 = require("./pda");
const types_1 = require("./types");
const idl_json_1 = __importDefault(require("./idl.json"));
// ── Anchor enum serialization maps ──
const SIDE_MAP = {
    [types_1.Side.Long]: { long: {} },
    [types_1.Side.Short]: { short: {} },
};
const ORACLE_SOURCE_MAP = {
    [types_1.OracleSource.Pyth]: { pyth: {} },
    [types_1.OracleSource.PerkOracle]: { perkOracle: {} },
    [types_1.OracleSource.DexPool]: { dexPool: {} },
};
const ORDER_TYPE_MAP = {
    [types_1.TriggerOrderType.Limit]: { limit: {} },
    [types_1.TriggerOrderType.StopLoss]: { stopLoss: {} },
    [types_1.TriggerOrderType.TakeProfit]: { takeProfit: {} },
};
class PerkClient {
    constructor(config) {
        this.connection = config.connection;
        this.wallet = config.wallet;
        this.programId = config.programId ?? constants_1.PERK_PROGRAM_ID;
        this.preInstructions = config.preInstructions ?? [];
        this.provider = new anchor_1.AnchorProvider(config.connection, config.wallet, { commitment: config.commitment ?? "confirmed" });
        this.program = new anchor_1.Program(idl_json_1.default, this.provider);
        this.accounts = this.program.account;
    }
    // ═══════════════════════════════════════════════
    // PDA Helpers
    // ═══════════════════════════════════════════════
    getProtocolAddress() {
        return (0, pda_1.findProtocolAddress)(this.programId)[0];
    }
    getMarketAddress(tokenMint) {
        return (0, pda_1.findMarketAddress)(tokenMint, this.programId)[0];
    }
    getPositionAddress(market, user) {
        return (0, pda_1.findPositionAddress)(market, user, this.programId)[0];
    }
    getVaultAddress(market) {
        return (0, pda_1.findVaultAddress)(market, this.programId)[0];
    }
    getTriggerOrderAddress(market, user, orderId) {
        return (0, pda_1.findTriggerOrderAddress)(market, user, orderId, this.programId)[0];
    }
    getPerkOracleAddress(tokenMint) {
        return (0, pda_1.findPerkOracleAddress)(tokenMint, this.programId)[0];
    }
    // ═══════════════════════════════════════════════
    // Account Fetchers
    // ═══════════════════════════════════════════════
    async fetchProtocol() {
        const address = this.getProtocolAddress();
        return (await this.accounts.protocol.fetch(address));
    }
    async fetchMarket(tokenMint) {
        const address = this.getMarketAddress(tokenMint);
        return (await this.accounts.market.fetch(address));
    }
    async fetchMarketByAddress(address) {
        return (await this.accounts.market.fetch(address));
    }
    async fetchAllMarkets() {
        const accounts = await this.accounts.market.all();
        return accounts.map((a) => ({
            address: a.publicKey,
            account: a.account,
        }));
    }
    async fetchPosition(market, user) {
        const address = this.getPositionAddress(market, user);
        return (await this.accounts.userPosition.fetch(address));
    }
    async fetchPositionByAddress(address) {
        return (await this.accounts.userPosition.fetch(address));
    }
    async fetchAllPositions(user) {
        const accounts = await this.accounts.userPosition.all([
            { memcmp: { offset: 8, bytes: user.toBase58() } },
        ]);
        return accounts.map((a) => ({
            address: a.publicKey,
            account: a.account,
        }));
    }
    async fetchTriggerOrder(address) {
        return (await this.accounts.triggerOrder.fetch(address));
    }
    async fetchTriggerOrders(market, user) {
        const accounts = await this.accounts.triggerOrder.all([
            { memcmp: { offset: 8, bytes: user.toBase58() } }, // authority at offset 8
            { memcmp: { offset: 8 + 32, bytes: market.toBase58() } }, // market at offset 40
        ]);
        return accounts
            .map((a) => ({
            address: a.publicKey,
            account: a.account,
        }));
    }
    /** Fetch a PerkOracle account. */
    async fetchPerkOracle(tokenMint) {
        const address = this.getPerkOracleAddress(tokenMint);
        return (await this.accounts.perkOraclePrice.fetch(address));
    }
    /** Fetch a PerkOracle account, returning null if not found. */
    async fetchPerkOracleNullable(tokenMint) {
        const address = this.getPerkOracleAddress(tokenMint);
        return (await this.accounts.perkOraclePrice.fetchNullable(address));
    }
    // ═══════════════════════════════════════════════
    // Admin Instructions
    // ═══════════════════════════════════════════════
    /** Initialize the protocol (admin only, once). */
    async initializeProtocol(protocolFeeVault) {
        const protocol = this.getProtocolAddress();
        return this.program.methods
            .initializeProtocol()
            .accounts({
            protocol,
            admin: this.wallet.publicKey,
            protocolFeeVault,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Propose a new admin (current admin only). */
    async proposeAdmin(newAdmin) {
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
    async acceptAdmin() {
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
    async adminPause(paused) {
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
    async adminUpdateMarket(tokenMint, oracle, params) {
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
    async adminWithdrawSol(amount) {
        const protocol = this.getProtocolAddress();
        return this.program.methods
            .adminWithdrawSol(amount)
            .accounts({
            protocol,
            admin: this.wallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    // ═══════════════════════════════════════════════
    // Market Instructions
    // ═══════════════════════════════════════════════
    /** Create a new perpetual futures market. */
    async createMarket(tokenMint, oracle, params) {
        const protocol = this.getProtocolAddress();
        const [market] = (0, pda_1.findMarketAddress)(tokenMint, this.programId);
        const [vault] = (0, pda_1.findVaultAddress)(market, this.programId);
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
            systemProgram: web3_js_1.SystemProgram.programId,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
            rent: web3_js_1.SYSVAR_RENT_PUBKEY,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    // ═══════════════════════════════════════════════
    // Position Instructions
    // ═══════════════════════════════════════════════
    /** Initialize a position account for a user on a market. */
    async initializePosition(tokenMint) {
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
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Deposit collateral into a position. */
    async deposit(tokenMint, oracle, amount, fallbackOracle) {
        const protocol = this.getProtocolAddress();
        const market = this.getMarketAddress(tokenMint);
        const position = this.getPositionAddress(market, this.wallet.publicKey);
        const [vault] = (0, pda_1.findVaultAddress)(market, this.programId);
        const userAta = await (0, spl_token_1.getAssociatedTokenAddress)(tokenMint, this.wallet.publicKey);
        return this.program.methods
            .deposit(amount)
            .accounts({
            protocol,
            market,
            userPosition: position,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            userTokenAccount: userAta,
            vault,
            user: this.wallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Withdraw collateral from a position. */
    async withdraw(tokenMint, oracle, amount, fallbackOracle) {
        const protocol = this.getProtocolAddress();
        const market = this.getMarketAddress(tokenMint);
        const position = this.getPositionAddress(market, this.wallet.publicKey);
        const [vault] = (0, pda_1.findVaultAddress)(market, this.programId);
        const userAta = await (0, spl_token_1.getAssociatedTokenAddress)(tokenMint, this.wallet.publicKey);
        return this.program.methods
            .withdraw(amount)
            .accounts({
            protocol,
            market,
            userPosition: position,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            userTokenAccount: userAta,
            vault,
            authority: this.wallet.publicKey,
            user: this.wallet.publicKey,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Open a leveraged position. */
    async openPosition(tokenMint, oracle, side, baseSize, leverage, maxSlippageBps = 500, fallbackOracle) {
        // Input validation — catch bad values before they hit Borsh serialization
        if (leverage < constants_1.MIN_LEVERAGE || leverage > constants_1.MAX_LEVERAGE) {
            throw new Error(`leverage must be ${constants_1.MIN_LEVERAGE}-${constants_1.MAX_LEVERAGE} (${constants_1.MIN_LEVERAGE / constants_1.LEVERAGE_SCALE}x-${constants_1.MAX_LEVERAGE / constants_1.LEVERAGE_SCALE}x), got ${leverage}`);
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
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            authority: this.wallet.publicKey,
            user: this.wallet.publicKey,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Close a position (full or partial). */
    async closePosition(tokenMint, oracle, baseSizeToClose, fallbackOracle) {
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
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            authority: this.wallet.publicKey,
            user: this.wallet.publicKey,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    // ═══════════════════════════════════════════════
    // Trigger Orders
    // ═══════════════════════════════════════════════
    /** Place a trigger order (limit, stop-loss, take-profit). */
    async placeTriggerOrder(tokenMint, params) {
        const market = this.getMarketAddress(tokenMint);
        const position = this.getPositionAddress(market, this.wallet.publicKey);
        // Fetch position to get next order ID
        const pos = await this.fetchPositionByAddress(position);
        const orderId = pos.nextOrderId;
        const triggerOrder = this.getTriggerOrderAddress(market, this.wallet.publicKey, orderId);
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
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Cancel a trigger order. */
    async cancelTriggerOrder(tokenMint, orderId) {
        const market = this.getMarketAddress(tokenMint);
        const position = this.getPositionAddress(market, this.wallet.publicKey);
        const triggerOrder = this.getTriggerOrderAddress(market, this.wallet.publicKey, orderId);
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
    async claimFees(tokenMint, recipientTokenAccount) {
        const protocol = this.getProtocolAddress();
        const market = this.getMarketAddress(tokenMint);
        const [vault] = (0, pda_1.findVaultAddress)(market, this.programId);
        return this.program.methods
            .claimFees()
            .accounts({
            protocol,
            market,
            vault,
            recipientTokenAccount,
            claimer: this.wallet.publicKey,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    // ═══════════════════════════════════════════════
    // Cranker Instructions
    // ═══════════════════════════════════════════════
    /** Crank funding rate update. */
    async crankFunding(marketAddress, oracle, fallbackOracle) {
        return this.program.methods
            .crankFunding()
            .accounts({
            market: marketAddress,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            cranker: this.wallet.publicKey,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Liquidate an underwater position. */
    async liquidate(marketAddress, oracle, targetUser, liquidatorTokenAccount, fallbackOracle) {
        const protocol = this.getProtocolAddress();
        const position = this.getPositionAddress(marketAddress, targetUser);
        const [vault] = (0, pda_1.findVaultAddress)(marketAddress, this.programId);
        return this.program.methods
            .liquidate()
            .accounts({
            protocol,
            market: marketAddress,
            userPosition: position,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            targetUser,
            liquidatorTokenAccount,
            vault,
            liquidator: this.wallet.publicKey,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Execute a trigger order that has been triggered. */
    async executeTriggerOrder(marketAddress, oracle, targetUser, orderId, executorTokenAccount, fallbackOracle) {
        const protocol = this.getProtocolAddress();
        const position = this.getPositionAddress(marketAddress, targetUser);
        const triggerOrder = this.getTriggerOrderAddress(marketAddress, targetUser, orderId);
        const [vault] = (0, pda_1.findVaultAddress)(marketAddress, this.programId);
        return this.program.methods
            .executeTriggerOrder()
            .accounts({
            protocol,
            market: marketAddress,
            userPosition: position,
            triggerOrder,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            executorTokenAccount,
            vault,
            executor: this.wallet.publicKey,
            tokenProgram: spl_token_1.TOKEN_PROGRAM_ID,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Update the vAMM peg multiplier (permissionless). */
    async updateAmm(marketAddress, oracle, fallbackOracle) {
        return this.program.methods
            .updateAmm()
            .accounts({
            market: marketAddress,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            caller: this.wallet.publicKey,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Reclaim an empty/abandoned position account (permissionless). */
    async reclaimEmptyAccount(marketAddress, oracle, positionOwner, fallbackOracle) {
        const position = this.getPositionAddress(marketAddress, positionOwner);
        return this.program.methods
            .reclaimEmptyAccount()
            .accounts({
            market: marketAddress,
            userPosition: position,
            oracle,
            fallbackOracle: fallbackOracle ?? web3_js_1.SystemProgram.programId,
            positionOwner,
            rentReceiver: positionOwner, // On-chain enforces rentReceiver == position.authority
            caller: this.wallet.publicKey,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    // ═══════════════════════════════════════════════
    // PerkOracle Instructions
    // ═══════════════════════════════════════════════
    /** Initialize a PerkOracle price feed. Admin only. */
    async initializePerkOracle(tokenMint, oracleAuthority, params) {
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
            oracleAuthority,
            admin: this.wallet.publicKey,
            systemProgram: web3_js_1.SystemProgram.programId,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Update a PerkOracle price feed. Authorized cranker only. */
    async updatePerkOracle(tokenMint, params) {
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
    async buildUpdatePerkOracleIx(tokenMint, params) {
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
    async freezePerkOracle(tokenMint, frozen) {
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
    async transferOracleAuthority(tokenMint, newAuthority) {
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
    async updateOracleConfig(tokenMint, params) {
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
        const protocol = this.getProtocolAddress();
        const perkOracle = this.getPerkOracleAddress(tokenMint);
        return this.program.methods
            .updateOracleConfig({
            maxPriceChangeBps: params.maxPriceChangeBps,
            minSources: params.minSources,
            maxStalenessSeconds: params.maxStalenessSeconds,
            circuitBreakerDeviationBps: params.circuitBreakerDeviationBps,
        })
            .accounts({
            protocol,
            perkOracle,
            admin: this.wallet.publicKey,
        })
            .preInstructions(this.preInstructions).rpc();
    }
    /** Set or remove fallback oracle on a market. Admin only. */
    async adminSetFallbackOracle(tokenMint, params) {
        const protocol = this.getProtocolAddress();
        const market = this.getMarketAddress(tokenMint);
        // When removing fallback (address = default/zeros), pass SystemProgram as the
        // account since Solana won't accept the null address as a transaction account.
        // The on-chain handler checks params.fallback_oracle_address == default and
        // short-circuits before reading the account, so the sentinel is never dereferenced.
        const isRemoving = params.fallbackOracleAddress.equals(web3_js_1.PublicKey.default);
        const fallbackAccount = isRemoving
            ? web3_js_1.SystemProgram.programId
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
exports.PerkClient = PerkClient;
//# sourceMappingURL=client.js.map