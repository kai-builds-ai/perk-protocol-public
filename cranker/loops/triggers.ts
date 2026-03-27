import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import {
  PerkClient,
  MarketAccount,
  TriggerOrderAccount,
  TriggerOrderType,
  Side,
} from "@perk/sdk";
import { CrankerConfig } from "../config";
import { createLogger } from "../logger";
import { TxRateLimiter } from "../rate-limiter";

const log = createLogger("triggers");

interface TriggersLoopState {
  running: boolean;
  consecutiveFailures: number;
}

// Cache for executor token accounts
const executorAtaCache = new Map<string, PublicKey>();

async function getOrCacheExecutorAta(
  crankerPubkey: PublicKey,
  collateralMint: PublicKey,
): Promise<PublicKey> {
  const key = `${crankerPubkey.toBase58()}-${collateralMint.toBase58()}`;
  const cached = executorAtaCache.get(key);
  if (cached) return cached;

  const ata = await getAssociatedTokenAddress(collateralMint, crankerPubkey);
  executorAtaCache.set(key, ata);
  return ata;
}

/**
 * Check if a trigger order's condition is met given the current oracle price.
 */
export function isTriggered(
  order: TriggerOrderAccount,
  oraclePrice: BN,
): boolean {
  const tp = order.triggerPrice;

  switch (order.orderType) {
    case TriggerOrderType.StopLoss:
      if (order.side === Side.Long) {
        // StopLoss Long: oracle <= triggerPrice
        return oraclePrice.lte(tp);
      } else {
        // StopLoss Short: oracle >= triggerPrice
        return oraclePrice.gte(tp);
      }

    case TriggerOrderType.TakeProfit:
      if (order.side === Side.Long) {
        // TakeProfit Long: oracle >= triggerPrice
        return oraclePrice.gte(tp);
      } else {
        // TakeProfit Short: oracle <= triggerPrice
        return oraclePrice.lte(tp);
      }

    case TriggerOrderType.Limit:
      if (order.side === Side.Long) {
        // Limit Long: oracle <= triggerPrice (buy low)
        return oraclePrice.lte(tp);
      } else {
        // Limit Short: oracle >= triggerPrice (sell high)
        return oraclePrice.gte(tp);
      }

    default:
      return false;
  }
}

function orderTypeLabel(orderType: TriggerOrderType): string {
  switch (orderType) {
    case TriggerOrderType.Limit: return "Limit";
    case TriggerOrderType.StopLoss: return "StopLoss";
    case TriggerOrderType.TakeProfit: return "TakeProfit";
    default: return `Unknown(${orderType})`;
  }
}

function sideLabel(side: Side): string {
  return side === Side.Long ? "Long" : "Short";
}

// Fix 8: Safety limit for unbounded account fetches
const MAX_TRIGGER_ACCOUNTS = 5000;

export function startTriggersLoop(
  client: PerkClient,
  markets: { address: PublicKey; account: MarketAccount }[],
  config: CrankerConfig,
  limiter?: TxRateLimiter,
): { stop: () => void } {
  const state: TriggersLoopState = {
    running: true,
    consecutiveFailures: 0,
  };

  log.info("Triggers loop starting", {
    marketCount: markets.length,
    intervalMs: config.triggerIntervalMs,
  });

  const tick = async (): Promise<void> => {
    for (const { address, account } of markets) {
      if (!state.running) return;
      if (!account.active) continue;

      try {
        // Get fresh market state for oracle price
        const freshMarket = await client.fetchMarketByAddress(address);
        const oraclePrice = freshMarket.lastOraclePrice;

        if (oraclePrice.isZero()) {
          log.debug("Market has no oracle price — skipping triggers", undefined, address.toBase58());
          continue;
        }

        // Fetch all trigger orders for this market
        const allOrders = await client.accounts.triggerOrder.all([
          { memcmp: { offset: 8 + 32, bytes: address.toBase58() } }, // market at offset 40 (8 discriminator + 32 authority)
        ]) as Array<{ publicKey: PublicKey; account: Record<string, unknown> }>;

        // Fix 8: Cap fetched accounts to prevent OOM
        if (allOrders.length > MAX_TRIGGER_ACCOUNTS) {
          log.warn(`${allOrders.length} trigger orders exceeds safety limit, processing first ${MAX_TRIGGER_ACCOUNTS}`, {
            market: address.toBase58(),
          }, address.toBase58());
          allOrders.length = MAX_TRIGGER_ACCOUNTS;
        }

        for (const orderEntry of allOrders) {
          if (!state.running) return;

          const order = orderEntry.account as unknown as TriggerOrderAccount;
          const orderAddress = orderEntry.publicKey;

          // Check expiry
          if (!order.expiry.isZero()) {
            const nowSec = Math.floor(Date.now() / 1000);
            if (order.expiry.toNumber() < nowSec) {
              log.debug("Trigger order expired", {
                order: orderAddress.toBase58(),
                expiry: order.expiry.toString(),
              }, address.toBase58());
              continue; // Expired orders are not executable
            }
          }

          if (!isTriggered(order, oraclePrice)) continue;

          // Order is triggered!
          const targetUser = order.authority;
          const orderId = order.orderId;

          log.info("Trigger order triggered", {
            market: address.toBase58(),
            user: targetUser.toBase58(),
            orderId: orderId.toString(),
            type: orderTypeLabel(order.orderType),
            side: sideLabel(order.side),
            triggerPrice: order.triggerPrice.toString(),
            oraclePrice: oraclePrice.toString(),
            size: order.size.toString(),
          }, address.toBase58());

          if (config.dryRun) {
            log.info("DRY RUN: would execute trigger order", {
              order: orderAddress.toBase58(),
            });
            continue;
          }

          try {
            // Fix 2: Rate limiter check
            if (limiter && !limiter.canSend()) {
              log.warn("Rate limit reached — skipping trigger execution", {
                market: address.toBase58(),
                orderId: orderId.toString(),
              });
              break; // Stop processing more orders this tick
            }

            const executorAta = await getOrCacheExecutorAta(
              client.wallet.publicKey,
              freshMarket.collateralMint,
            );

            // Record rate limit BEFORE sending to avoid TOCTOU
            if (limiter) limiter.record();

            const fallback = freshMarket.fallbackOracleAddress;
            const sig = await client.executeTriggerOrder(
              address,
              freshMarket.tokenMint,
              freshMarket.oracleAddress,
              targetUser,
              orderId,
              executorAta,
              fallback.equals(PublicKey.default) ? undefined : fallback,
            );

            log.info("Trigger order executed", {
              market: address.toBase58(),
              user: targetUser.toBase58(),
              orderId: orderId.toString(),
              type: orderTypeLabel(order.orderType),
              sig,
            }, address.toBase58());

            state.consecutiveFailures = 0;
          } catch (execErr) {
            log.error("Trigger order execution failed", {
              market: address.toBase58(),
              user: targetUser.toBase58(),
              orderId: orderId.toString(),
              error: String(execErr),
            }, address.toBase58());
          }
        }
      } catch (err) {
        state.consecutiveFailures++;
        log.error("Trigger scan failed", {
          market: address.toBase58(),
          error: String(err),
          consecutiveFailures: state.consecutiveFailures,
        }, address.toBase58());

        if (state.consecutiveFailures > 10) {
          log.error("Too many consecutive trigger failures — pausing 60s");
          await sleep(60_000);
          state.consecutiveFailures = 0;
        }
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (state.running) {
      await tick();
      await sleep(config.triggerIntervalMs);
    }
  };

  // Fix 3: Restart loop on crash instead of dying silently
  const runWithRestart = async (): Promise<void> => {
    while (state.running) {
      try {
        await loop();
      } catch (err) {
        log.error("Triggers loop crashed, restarting in 10s", { error: String(err) });
        await sleep(10_000);
      }
    }
  };
  runWithRestart().catch((err) => {
    log.error("Triggers loop fatal", { error: String(err) });
  });

  return {
    stop: () => {
      state.running = false;
    },
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
