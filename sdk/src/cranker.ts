import {
  Connection,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import { Wallet } from "@coral-xyz/anchor";
import { PerkClient } from "./client";
import {
  MarketAccount,
  UserPositionAccount,
  TriggerOrderAccount,
  Side,
} from "./types";
import { isLiquidatable } from "./math";
import {
  MAX_TRIGGER_ORDER_AGE_SECONDS,
  DUST_THRESHOLD,
  ORACLE_STALENESS_SECONDS,
} from "./constants";

// ── Helpers ──

/** Check if an Anchor-deserialized enum matches a variant name. */
function isEnumVariant(anchorEnum: any, variant: string): boolean {
  if (typeof anchorEnum === "object" && anchorEnum !== null) {
    return variant in anchorEnum;
  }
  return false;
}

/** Get the trigger order type as a string from Anchor-deserialized enum. */
function getOrderType(
  anchorEnum: any
): "limit" | "stopLoss" | "takeProfit" | null {
  if (typeof anchorEnum === "object" && anchorEnum !== null) {
    if ("limit" in anchorEnum) return "limit";
    if ("stopLoss" in anchorEnum) return "stopLoss";
    if ("takeProfit" in anchorEnum) return "takeProfit";
  }
  return null;
}

/** Check if order is on the long side (Anchor-deserialized). */
function isLongSide(anchorSide: any): boolean {
  if (typeof anchorSide === "object" && anchorSide !== null) {
    return "long" in anchorSide;
  }
  return false;
}

/** Check if a trigger order should execute given oracle price. */
function shouldTriggerExecute(
  order: TriggerOrderAccount,
  oraclePrice: number
): boolean {
  const triggerPrice = order.triggerPrice.toNumber();
  const orderType = getOrderType(order.orderType);
  const isLong = isLongSide(order.side);

  switch (orderType) {
    case "limit":
      return isLong ? oraclePrice <= triggerPrice : oraclePrice >= triggerPrice;
    case "stopLoss":
      return isLong ? oraclePrice <= triggerPrice : oraclePrice >= triggerPrice;
    case "takeProfit":
      return isLong ? oraclePrice >= triggerPrice : oraclePrice <= triggerPrice;
    default:
      return false;
  }
}

/** Check if a trigger order would increase OI on a drain-only side. */
function wouldIncreaseOI(
  order: TriggerOrderAccount,
  market: MarketAccount
): boolean {
  if (order.reduceOnly) return false;
  const isLong = isLongSide(order.side);
  if (isLong && isEnumVariant(market.longState, "drainOnly")) return true;
  if (!isLong && isEnumVariant(market.shortState, "drainOnly")) return true;
  return false;
}

/** Resolve fallback oracle account: use the market's configured address, or SystemProgram as sentinel. */
function resolveFallbackOracle(market: MarketAccount): PublicKey {
  const addr = market.fallbackOracleAddress;
  if (addr.equals(PublicKey.default)) return SystemProgram.programId;
  return addr;
}

// ── Types ──

export interface CrankerConfig {
  connection: Connection;
  wallet: Wallet;
  /** Markets to crank (by address). If empty, cranks all active markets. */
  markets?: PublicKey[];
  /** Polling interval in ms (default: 5000). */
  pollIntervalMs?: number;
  /** Whether to run liquidations (default: true). */
  enableLiquidations?: boolean;
  /** Whether to crank funding (default: true). */
  enableFunding?: boolean;
  /** Whether to execute trigger orders (default: true). */
  enableTriggerOrders?: boolean;
  /** Whether to update AMM peg (default: true). */
  enablePegUpdate?: boolean;
  /** Whether to reclaim empty accounts (default: false). */
  enableReclaim?: boolean;
  /** Token account to receive liquidation/execution rewards. */
  rewardTokenAccount?: PublicKey;
  /** Priority fee in microlamports per compute unit (default: 0 = no priority fee). */
  priorityFeeMicroLamports?: number;
  /** Callback for logging. */
  onLog?: (msg: string) => void;
  /** Callback for errors. */
  onError?: (err: Error, context: string) => void;
  /** Callback for metrics (called per tick with stats). */
  onMetrics?: (metrics: CrankerMetrics) => void;
}

export interface CrankerMetrics {
  tickDurationMs: number;
  marketsProcessed: number;
  liquidationsAttempted: number;
  liquidationsSucceeded: number;
  triggerOrdersExecuted: number;
  fundingCranked: number;
  pegUpdates: number;
  reclaimsAttempted: number;
  errors: number;
}

export class PerkCranker {
  private client: PerkClient;
  private config: CrankerConfig;
  private running = false;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private tickInProgress = false;

  /** Cache: collateral mint → ATA address for this wallet. */
  private ataCache = new Map<string, PublicKey>();

  constructor(config: CrankerConfig) {
    this.config = config;

    // Build preInstructions for priority fees
    const preInstructions: TransactionInstruction[] = [];
    if (config.priorityFeeMicroLamports && config.priorityFeeMicroLamports > 0) {
      preInstructions.push(
        ComputeBudgetProgram.setComputeUnitPrice({
          microLamports: config.priorityFeeMicroLamports,
        })
      );
    }

    this.client = new PerkClient({
      connection: config.connection,
      wallet: config.wallet,
      preInstructions,
    });
  }

  // ── Logging ──

  private log(msg: string) {
    if (this.config.onLog) this.config.onLog(msg);
    else console.log(`[Cranker] ${msg}`);
  }

  private handleError(err: Error, context: string) {
    if (this.config.onError) this.config.onError(err, context);
    else console.error(`[Cranker] ${context}: ${err.message}`);
  }

  // ── Lifecycle ──

  /** Start the cranker loop. */
  start() {
    if (this.running) return;
    this.running = true;
    this.log("Starting cranker...");

    const interval = this.config.pollIntervalMs ?? 5000;
    this.tick();
    this.intervalId = setInterval(() => this.tick(), interval);
  }

  /** Stop the cranker loop gracefully. Waits for current tick to finish (up to timeoutMs, default 30s). */
  stop(timeoutMs: number = 30_000): Promise<void> {
    this.running = false;
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.log("Cranker stopping...");

    return new Promise((resolve) => {
      const deadline = Date.now() + timeoutMs;
      const check = () => {
        if (!this.tickInProgress) {
          this.log("Cranker stopped.");
          resolve();
        } else if (Date.now() >= deadline) {
          this.log("Cranker stop timed out — tick still in progress.");
          resolve();
        } else {
          setTimeout(check, 100);
        }
      };
      check();
    });
  }

  /** Returns true if the cranker is currently running. */
  isRunning(): boolean {
    return this.running;
  }

  // ── Tick ──

  private async tick() {
    if (!this.running || this.tickInProgress) return;
    this.tickInProgress = true;
    try {
      return await this._tickInner();
    } finally {
      this.tickInProgress = false;
    }
  }

  private async _tickInner() {
    const tickStart = Date.now();
    const metrics: CrankerMetrics = {
      tickDurationMs: 0,
      marketsProcessed: 0,
      liquidationsAttempted: 0,
      liquidationsSucceeded: 0,
      triggerOrdersExecuted: 0,
      fundingCranked: 0,
      pegUpdates: 0,
      reclaimsAttempted: 0,
      errors: 0,
    };

    try {
      // Fetch markets — use allSettled so one bad market doesn't kill everything
      const markets = await this.fetchMarkets();

      for (const { address, account: marketInit } of markets) {
        let market = marketInit;
        if (!market.active) continue;
        metrics.marketsProcessed++;

        try {
          // 1. Crank funding
          if (this.config.enableFunding !== false) {
            const cranked = await this.crankFunding(address, market);
            if (cranked) metrics.fundingCranked++;
          }

          // 2. Update AMM peg (refreshes oracle price on-chain)
          if (this.config.enablePegUpdate !== false) {
            const updated = await this.updatePeg(address, market);
            if (updated) {
              metrics.pegUpdates++;
              // Re-fetch market after peg update so scans use fresh oracle price
              try {
                const freshMarket =
                  await this.client.fetchMarketByAddress(address);
                market = freshMarket;
              } catch (err) {
                this.handleError(
                  err as Error,
                  `re-fetch after peg ${address.toBase58().slice(0, 8)}`
                );
                metrics.errors++;
              }
            }
          }

          // Check oracle staleness — skip scans if price is too stale
          // (on-chain will use fresh oracle, so our client-side decisions
          // based on stale lastOraclePrice would be unreliable)
          const lastPegSlot = market.lastPegUpdateSlot?.toNumber?.() ?? 0;
          let currentSlot: number;
          try {
            currentSlot = await this.config.connection.getSlot();
          } catch {
            currentSlot = 0; // If we can't get slot, skip staleness check
          }
          // ~400ms per slot on Solana → convert staleness seconds to slots
          const maxStaleSlots = Math.ceil(
            ORACLE_STALENESS_SECONDS * 1000 / 400
          );
          const oracleIsStale =
            currentSlot > 0 &&
            lastPegSlot > 0 &&
            currentSlot - lastPegSlot > maxStaleSlots;

          if (oracleIsStale) {
            this.log(
              `Skipping scans for ${address.toBase58().slice(0, 8)} — oracle stale by ${currentSlot - lastPegSlot} slots`
            );
          }

          // Fetch positions and trigger orders in parallel for this market
          const [positions, orders] = await Promise.all([
            this.config.enableLiquidations !== false ||
            this.config.enableReclaim
              ? this.fetchPositions(address)
              : Promise.resolve([]),
            this.config.enableTriggerOrders !== false
              ? this.fetchTriggerOrders(address)
              : Promise.resolve([]),
          ]);

          // 3. Trigger orders FIRST (stop-losses can save positions from liquidation)
          // Skip if oracle is stale — our price-based decisions would be unreliable
          if (this.config.enableTriggerOrders !== false && !oracleIsStale) {
            const executed = await this.scanTriggerOrders(
              address,
              market,
              orders
            );
            metrics.triggerOrdersExecuted += executed;
          }

          // 4. Liquidations
          if (this.config.enableLiquidations !== false && !oracleIsStale) {
            const { attempted, succeeded } = await this.scanLiquidations(
              address,
              market,
              positions
            );
            metrics.liquidationsAttempted += attempted;
            metrics.liquidationsSucceeded += succeeded;
          }

          // 5. Reclaim empty accounts (any time, not just ResetPending)
          if (this.config.enableReclaim) {
            const reclaimed = await this.scanReclaims(
              address,
              market,
              positions
            );
            metrics.reclaimsAttempted += reclaimed;
          }
        } catch (err) {
          metrics.errors++;
          this.handleError(
            err as Error,
            `market ${address.toBase58().slice(0, 8)}`
          );
        }
      }
    } catch (err) {
      metrics.errors++;
      this.handleError(err as Error, "tick");
    }

    metrics.tickDurationMs = Date.now() - tickStart;
    if (this.config.onMetrics) {
      this.config.onMetrics(metrics);
    }
  }

  // ── Market fetching with allSettled ──

  private async fetchMarkets(): Promise<
    { address: PublicKey; account: MarketAccount }[]
  > {
    if (this.config.markets?.length) {
      const results = await Promise.allSettled(
        this.config.markets.map(async (addr) => ({
          address: addr,
          account: await this.client.fetchMarketByAddress(addr),
        }))
      );
      const markets: { address: PublicKey; account: MarketAccount }[] = [];
      for (let i = 0; i < results.length; i++) {
        const r = results[i];
        if (r.status === "fulfilled") {
          markets.push(r.value);
        } else {
          this.handleError(
            r.reason as Error,
            `fetch market ${this.config.markets[i].toBase58().slice(0, 8)}`
          );
        }
      }
      return markets;
    }
    return this.client.fetchAllMarkets();
  }

  // ── Position / order fetching ──

  private async fetchPositions(
    marketAddress: PublicKey
  ): Promise<{ publicKey: PublicKey; account: UserPositionAccount }[]> {
    const raw = await (this.client as any).accounts.userPosition.all([
      { memcmp: { offset: 8 + 32, bytes: marketAddress.toBase58() } },
    ]);
    return raw.map((r: any) => ({
      publicKey: r.publicKey,
      account: r.account as unknown as UserPositionAccount,
    }));
  }

  private async fetchTriggerOrders(
    marketAddress: PublicKey
  ): Promise<{ publicKey: PublicKey; account: TriggerOrderAccount }[]> {
    const raw = await (this.client as any).accounts.triggerOrder.all([
      { memcmp: { offset: 8 + 32, bytes: marketAddress.toBase58() } },
    ]);
    return raw.map((r: any) => ({
      publicKey: r.publicKey,
      account: r.account as unknown as TriggerOrderAccount,
    }));
  }

  // ── ATA cache ──

  private async getRewardAccount(collateralMint: PublicKey): Promise<PublicKey> {
    if (this.config.rewardTokenAccount) return this.config.rewardTokenAccount;
    const key = collateralMint.toBase58();
    let cached = this.ataCache.get(key);
    if (!cached) {
      cached = await getAssociatedTokenAddress(
        collateralMint,
        this.config.wallet.publicKey
      );
      this.ataCache.set(key, cached);
    }
    return cached;
  }

  // ── Funding ──

  private async crankFunding(
    marketAddress: PublicKey,
    market: MarketAccount
  ): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - market.lastFundingTime.toNumber();
    if (elapsed < market.fundingPeriodSeconds) return false;

    try {
      const sig = await this.client.crankFunding(
        marketAddress,
        market.oracleAddress,
        resolveFallbackOracle(market),
      );
      this.log(
        `Cranked funding for ${marketAddress.toBase58().slice(0, 8)}: ${sig}`
      );
      return true;
    } catch (err) {
      this.handleError(err as Error, "crankFunding");
      return false;
    }
  }

  // ── Peg update ──

  private async updatePeg(
    marketAddress: PublicKey,
    market: MarketAccount
  ): Promise<boolean> {
    try {
      const sig = await this.client.updateAmm(
        marketAddress,
        market.oracleAddress,
        resolveFallbackOracle(market),
      );
      this.log(
        `Updated AMM peg for ${marketAddress.toBase58().slice(0, 8)}: ${sig}`
      );
      return true;
    } catch (err) {
      const msg = (err as Error)?.message ?? "";
      // Expected: cooldown not elapsed, drift within threshold
      if (msg.includes("cooldown") || msg.includes("threshold")) {
        return false;
      }
      // Log all other errors (including Anchor error codes)
      this.handleError(err as Error, "updatePeg");
      return false;
    }
  }

  // ── Liquidations ──

  private async scanLiquidations(
    marketAddress: PublicKey,
    market: MarketAccount,
    positions: { publicKey: PublicKey; account: UserPositionAccount }[]
  ): Promise<{ attempted: number; succeeded: number }> {
    const oraclePrice = market.lastOraclePrice;
    let attempted = 0;
    let succeeded = 0;

    // Collect liquidatable positions
    const liquidatable: UserPositionAccount[] = [];
    for (const { account: pos } of positions) {
      if (pos.baseSize.isZero() && pos.basis.isZero()) continue;
      if (isLiquidatable(pos, market, oraclePrice)) {
        liquidatable.push(pos);
      }
    }

    if (liquidatable.length === 0) return { attempted: 0, succeeded: 0 };

    const rewardAccount = await this.getRewardAccount(market.collateralMint);

    // Execute liquidations (one per tx for now — batching requires
    // building raw transactions with the program's instruction builder)
    for (const pos of liquidatable) {
      attempted++;
      try {
        const sig = await this.client.liquidate(
          marketAddress,
          market.tokenMint,
          market.oracleAddress,
          pos.authority,
          rewardAccount,
          resolveFallbackOracle(market),
        );
        succeeded++;
        this.log(
          `Liquidated ${pos.authority.toBase58().slice(0, 8)} on ${marketAddress.toBase58().slice(0, 8)}: ${sig}`
        );
      } catch (err) {
        this.handleError(
          err as Error,
          `liquidate ${pos.authority.toBase58().slice(0, 8)}`
        );
      }
    }

    return { attempted, succeeded };
  }

  // ── Trigger orders ──

  private async scanTriggerOrders(
    marketAddress: PublicKey,
    market: MarketAccount,
    orders: { publicKey: PublicKey; account: TriggerOrderAccount }[]
  ): Promise<number> {
    const oraclePrice = market.lastOraclePrice.toNumber();
    let executed = 0;
    const now = Math.floor(Date.now() / 1000);

    for (const { account: order } of orders) {
      // Check expiry
      if (order.expiry.toNumber() > 0 && now > order.expiry.toNumber()) {
        continue;
      }

      // Check max age
      const createdAt = order.createdAt?.toNumber?.() ?? 0;
      if (
        createdAt > 0 &&
        now - createdAt > MAX_TRIGGER_ORDER_AGE_SECONDS
      ) {
        continue;
      }

      // Skip OI-increasing orders on drain-only sides (on-chain rejects them)
      if (wouldIncreaseOI(order, market)) continue;

      // Check if trigger condition is met
      if (shouldTriggerExecute(order, oraclePrice)) {
        try {
          const rewardAccount = await this.getRewardAccount(
            market.collateralMint
          );
          const sig = await this.client.executeTriggerOrder(
            marketAddress,
            market.tokenMint,
            market.oracleAddress,
            order.authority,
            order.orderId,
            rewardAccount,
            resolveFallbackOracle(market),
          );
          executed++;
          this.log(
            `Executed trigger order ${order.orderId.toString()} for ${order.authority.toBase58().slice(0, 8)}: ${sig}`
          );
        } catch (err) {
          this.handleError(
            err as Error,
            `executeTrigger ${order.orderId.toString()}`
          );
        }
      }
    }

    return executed;
  }

  // ── Reclaims ──

  private async scanReclaims(
    marketAddress: PublicKey,
    market: MarketAccount,
    positions: { publicKey: PublicKey; account: UserPositionAccount }[]
  ): Promise<number> {
    let reclaimed = 0;

    for (const { account: pos } of positions) {
      // Match on-chain reclaim_empty_account requirements
      if (!pos.baseSize.isZero() || !pos.basis.isZero()) continue;
      if (pos.depositedCollateral.toNumber() > DUST_THRESHOLD) continue;
      if (pos.openTriggerOrders > 0) continue;
      if (pos.feeCredits.isNeg()) continue; // Has fee debt — on-chain rejects

      try {
        const sig = await this.client.reclaimEmptyAccount(
          marketAddress,
          market.oracleAddress,
          pos.authority,
          resolveFallbackOracle(market),
        );
        reclaimed++;
        this.log(
          `Reclaimed empty account for ${pos.authority.toBase58().slice(0, 8)}: ${sig}`
        );
      } catch (err) {
        this.handleError(
          err as Error,
          `reclaim ${pos.authority.toBase58().slice(0, 8)}`
        );
      }
    }

    return reclaimed;
  }
}
