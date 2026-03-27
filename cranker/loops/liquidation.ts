import { PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress } from "@solana/spl-token";
import BN from "bn.js";
import { PerkClient, MarketAccount, MAINTENANCE_MARGIN_BPS, PRICE_SCALE, BPS_DENOMINATOR } from "@perk/sdk";
import { CrankerConfig } from "../config";
import { createLogger } from "../logger";
import { TxRateLimiter } from "../rate-limiter";

const log = createLogger("liquidation");

interface LiquidationLoopState {
  running: boolean;
  consecutiveFailures: number;
}

// Cache for token accounts to avoid repeated lookups
const tokenAccountCache = new Map<string, PublicKey>();

async function getOrCacheLiquidatorAta(
  crankerPubkey: PublicKey,
  collateralMint: PublicKey,
): Promise<PublicKey> {
  const key = `${crankerPubkey.toBase58()}-${collateralMint.toBase58()}`;
  const cached = tokenAccountCache.get(key);
  if (cached) return cached;

  const ata = await getAssociatedTokenAddress(collateralMint, crankerPubkey);
  tokenAccountCache.set(key, ata);
  return ata;
}

/**
 * Compute margin ratio for a position. Returns a fraction (e.g. 0.05 = 5%).
 * marginRatio = (collateral + unrealizedPnl) / notional
 * If notional is 0, returns Infinity (no position = safe).
 */
export function computeMarginRatio(
  depositedCollateral: BN,
  baseSize: BN,        // i64: positive = long, negative = short
  quoteEntryAmount: BN,
  oraclePrice: BN,     // in PRICE_SCALE
): number {
  if (baseSize.isZero()) return Infinity;

  const baseSizeAbs = baseSize.isNeg() ? baseSize.neg() : baseSize;
  // notional = baseSize * oraclePrice / PRICE_SCALE
  const notional = baseSizeAbs.mul(oraclePrice).div(new BN(PRICE_SCALE));
  if (notional.isZero()) return Infinity;

  // unrealizedPnl for long: (baseSize * oraclePrice / PRICE_SCALE) - quoteEntryAmount
  // unrealizedPnl for short: quoteEntryAmount - (baseSize * oraclePrice / PRICE_SCALE)
  const currentValue = baseSizeAbs.mul(oraclePrice).div(new BN(PRICE_SCALE));
  const isLong = !baseSize.isNeg();
  let pnl: BN;
  if (isLong) {
    pnl = currentValue.sub(quoteEntryAmount);
  } else {
    pnl = quoteEntryAmount.sub(currentValue);
  }

  // equity = collateral + pnl (as signed number)
  const equity = depositedCollateral.add(pnl);
  if (equity.isNeg()) return 0; // Underwater

  // marginRatio = equity / notional
  // Use fixed-point: multiply by 10000, then divide by 10000 at the end
  const ratioScaled = equity.mul(new BN(BPS_DENOMINATOR)).div(notional);
  return ratioScaled.toNumber() / BPS_DENOMINATOR;
}

// Fix 8: Safety limit for unbounded account fetches
const MAX_ACCOUNTS = 5000;

// Fix 9: Safety buffer — only liquidate positions clearly below maintenance margin
const LIQUIDATION_SAFETY_FACTOR = 0.95;

export function startLiquidationLoop(
  client: PerkClient,
  markets: { address: PublicKey; account: MarketAccount }[],
  config: CrankerConfig,
  limiter?: TxRateLimiter,
): { stop: () => void } {
  const state: LiquidationLoopState = {
    running: true,
    consecutiveFailures: 0,
  };

  log.info("Liquidation loop starting", {
    marketCount: markets.length,
    intervalMs: config.liquidationIntervalMs,
    maintenanceMarginBps: MAINTENANCE_MARGIN_BPS,
  });

  const tick = async (): Promise<void> => {
    for (const { address, account } of markets) {
      if (!state.running) return;
      if (!account.active) continue;

      try {
        // Fetch all positions for this market
        const allPositions = await client.accounts.userPosition.all([
          { memcmp: { offset: 8 + 32, bytes: address.toBase58() } }, // market field at offset 8 + 32 (after authority)
        ]) as Array<{ publicKey: PublicKey; account: Record<string, unknown> }>;

        // Get the current oracle price from market state
        const freshMarket = await client.fetchMarketByAddress(address);
        const oraclePrice = freshMarket.lastOraclePrice;

        // Fix 8: Cap fetched accounts — sort by margin ratio so most underwater come first
        if (allPositions.length > MAX_ACCOUNTS) {
          log.warn(`${allPositions.length} positions exceeds safety limit`, {
            market: address.toBase58(),
          }, address.toBase58());

          // Score and sort: lowest margin ratio first (most urgent to liquidate)
          const scored = allPositions.map((pos) => {
            const pa = pos.account as unknown as {
              depositedCollateral: BN; baseSize: BN; quoteEntryAmount: BN;
            };
            const ratio = pa.baseSize.isZero() ? Infinity : computeMarginRatio(
              pa.depositedCollateral, pa.baseSize, pa.quoteEntryAmount, oraclePrice,
            );
            return { pos, ratio };
          });
          scored.sort((a, b) => a.ratio - b.ratio);
          allPositions.length = 0;
          for (let i = 0; i < MAX_ACCOUNTS && i < scored.length; i++) {
            allPositions.push(scored[i].pos);
          }
        }

        if (oraclePrice.isZero()) {
          log.debug("Market has no oracle price yet — skipping", undefined, address.toBase58());
          continue;
        }

        const maintenanceRatio = MAINTENANCE_MARGIN_BPS / BPS_DENOMINATOR;

        for (const pos of allPositions) {
          if (!state.running) return;

          const posAccount = pos.account as unknown as {
            authority: PublicKey;
            market: PublicKey;
            depositedCollateral: BN;
            baseSize: BN;
            quoteEntryAmount: BN;
          };

          // Skip empty positions
          if ((posAccount.baseSize as BN).isZero()) continue;

          const marginRatio = computeMarginRatio(
            posAccount.depositedCollateral,
            posAccount.baseSize,
            posAccount.quoteEntryAmount,
            oraclePrice,
          );

          // Fix 9: Apply safety buffer — only liquidate if margin is clearly below maintenance
          // This prevents attempting to liquidate borderline positions where off-chain
          // and on-chain calculations might disagree
          if (marginRatio >= maintenanceRatio * LIQUIDATION_SAFETY_FACTOR) continue;

          // This position is liquidatable
          const targetUser = posAccount.authority;
          const liquidatorAta = await getOrCacheLiquidatorAta(
            client.wallet.publicKey,
            freshMarket.collateralMint,
          );

          log.info("Liquidatable position found", {
            market: address.toBase58(),
            user: targetUser.toBase58(),
            marginRatio: marginRatio.toFixed(4),
            baseSize: posAccount.baseSize.toString(),
            collateral: posAccount.depositedCollateral.toString(),
          }, address.toBase58());

          if (config.dryRun) {
            log.info("DRY RUN: would liquidate", {
              market: address.toBase58(),
              user: targetUser.toBase58(),
            });
            continue;
          }

          try {
            // Fix 2: Rate limiter check
            if (limiter && !limiter.canSend()) {
              log.warn("Rate limit reached — skipping liquidation", {
                market: address.toBase58(),
                user: targetUser.toBase58(),
              });
              break; // Stop processing more positions this tick
            }

            // Record rate limit BEFORE sending to avoid TOCTOU
            if (limiter) limiter.record();

            const fallback = freshMarket.fallbackOracleAddress;
            const sig = await client.liquidate(
              address,
              freshMarket.tokenMint,
              freshMarket.oracleAddress,
              targetUser,
              liquidatorAta,
              fallback.equals(PublicKey.default) ? undefined : fallback,
            );

            log.info("Position liquidated", {
              market: address.toBase58(),
              user: targetUser.toBase58(),
              sig,
              marginRatio: marginRatio.toFixed(4),
              baseSize: posAccount.baseSize.toString(),
            }, address.toBase58());

            state.consecutiveFailures = 0;
          } catch (liqErr) {
            // Liquidation tx failed — log but keep scanning
            log.error("Liquidation tx failed", {
              market: address.toBase58(),
              user: targetUser.toBase58(),
              error: String(liqErr),
            }, address.toBase58());
          }
        }
      } catch (err) {
        state.consecutiveFailures++;
        log.error("Liquidation scan failed", {
          market: address.toBase58(),
          error: String(err),
          consecutiveFailures: state.consecutiveFailures,
        }, address.toBase58());

        if (state.consecutiveFailures > 10) {
          log.error("Too many consecutive liquidation failures — pausing 60s");
          await sleep(60_000);
          state.consecutiveFailures = 0;
        }
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (state.running) {
      await tick();
      await sleep(config.liquidationIntervalMs);
    }
  };

  // Fix 3: Restart loop on crash instead of dying silently
  const runWithRestart = async (): Promise<void> => {
    while (state.running) {
      try {
        await loop();
      } catch (err) {
        log.error("Liquidation loop crashed, restarting in 10s", { error: String(err) });
        await sleep(10_000);
      }
    }
  };
  runWithRestart().catch((err) => {
    log.error("Liquidation loop fatal", { error: String(err) });
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
