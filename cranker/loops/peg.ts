import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";
import { PerkClient, MarketAccount, PRICE_SCALE } from "@perk/sdk";
import { CrankerConfig } from "../config";
import { createLogger } from "../logger";
import { TxRateLimiter } from "../rate-limiter";

const log = createLogger("peg");

interface PegLoopState {
  running: boolean;
  consecutiveFailures: number;
}

const PEG_DIVERGENCE_THRESHOLD = 0.005; // 0.5%

/**
 * Compute mark price from vAMM reserves:
 * markPrice = (quoteReserve * pegMultiplier) / baseReserve
 *
 * pegMultiplier is stored in PRICE_SCALE (1e6) on-chain, so the result
 * is already in PRICE_SCALE.
 *
 * Fix 7: Removed incorrect K_SCALE division. K_SCALE is the invariant
 * scale (k = base * quote), NOT a price divisor. The Rust on-chain
 * vamm::calculate_mark_price does: quote * peg / base.
 */
function computeMarkPrice(market: MarketAccount): BN {
  if (market.baseReserve.isZero()) return new BN(0);

  // markPrice = quoteReserve * pegMultiplier / baseReserve
  // pegMultiplier is in PRICE_SCALE, so result is in PRICE_SCALE
  const numerator = market.quoteReserve.mul(market.pegMultiplier);
  return numerator.div(market.baseReserve);
}

export function startPegLoop(
  client: PerkClient,
  markets: { address: PublicKey; account: MarketAccount }[],
  config: CrankerConfig,
  limiter?: TxRateLimiter,
): { stop: () => void } {
  const state: PegLoopState = {
    running: true,
    consecutiveFailures: 0,
  };

  log.info("Peg loop starting", {
    marketCount: markets.length,
    intervalMs: config.pegIntervalMs,
    threshold: `${PEG_DIVERGENCE_THRESHOLD * 100}%`,
  });

  const tick = async (): Promise<void> => {
    for (const { address } of markets) {
      if (!state.running) return;

      try {
        // Always fetch fresh market data
        const freshMarket = await client.fetchMarketByAddress(address);
        if (!freshMarket.active) continue;

        const oraclePrice = freshMarket.lastOraclePrice;
        if (oraclePrice.isZero()) {
          log.debug("Market has no oracle price — skipping peg check", undefined, address.toBase58());
          continue;
        }

        const markPrice = computeMarkPrice(freshMarket);
        if (markPrice.isZero()) {
          log.debug("Mark price is zero — skipping peg check", undefined, address.toBase58());
          continue;
        }

        // Compute divergence: |mark - oracle| / oracle
        const diff = markPrice.sub(oraclePrice).abs();
        // divergence = diff / oraclePrice (as float for comparison)
        const divergence = diff.muln(10000).div(oraclePrice).toNumber() / 10000;

        if (divergence <= PEG_DIVERGENCE_THRESHOLD) {
          log.debug("Peg within threshold", {
            market: address.toBase58(),
            markPrice: markPrice.toString(),
            oraclePrice: oraclePrice.toString(),
            divergence: `${(divergence * 100).toFixed(2)}%`,
          }, address.toBase58());
          continue;
        }

        log.info("Peg divergence detected", {
          market: address.toBase58(),
          markPrice: markPrice.toString(),
          oraclePrice: oraclePrice.toString(),
          divergence: `${(divergence * 100).toFixed(2)}%`,
        }, address.toBase58());

        if (config.dryRun) {
          log.info("DRY RUN: would update AMM peg", {
            market: address.toBase58(),
            divergence: `${(divergence * 100).toFixed(2)}%`,
          });
          continue;
        }

        // Fix 2: Rate limiter check
        if (limiter && !limiter.canSend()) {
          log.warn("Rate limit reached — skipping peg update", { market: address.toBase58() });
          continue;
        }

        // Record rate limit BEFORE sending to avoid TOCTOU
        if (limiter) limiter.record();

        const fallback = freshMarket.fallbackOracleAddress;
        const sig = await client.updateAmm(
          address,
          freshMarket.oracleAddress,
          fallback.equals(PublicKey.default) ? undefined : fallback,
        );

        log.info("AMM peg updated", {
          market: address.toBase58(),
          sig,
          markPrice: markPrice.toString(),
          oraclePrice: oraclePrice.toString(),
          divergence: `${(divergence * 100).toFixed(2)}%`,
        }, address.toBase58());

        state.consecutiveFailures = 0;
      } catch (err) {
        state.consecutiveFailures++;
        log.error("Peg update failed", {
          market: address.toBase58(),
          error: String(err),
          consecutiveFailures: state.consecutiveFailures,
        }, address.toBase58());

        if (state.consecutiveFailures > 10) {
          log.error("Too many consecutive peg failures — pausing 60s");
          await sleep(60_000);
          state.consecutiveFailures = 0;
        }
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (state.running) {
      await tick();
      await sleep(config.pegIntervalMs);
    }
  };

  // Fix 3: Restart loop on crash instead of dying silently
  const runWithRestart = async (): Promise<void> => {
    while (state.running) {
      try {
        await loop();
      } catch (err) {
        log.error("Peg loop crashed, restarting in 10s", { error: String(err) });
        await sleep(10_000);
      }
    }
  };
  runWithRestart().catch((err) => {
    log.error("Peg loop fatal", { error: String(err) });
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
