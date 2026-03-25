import { PublicKey } from "@solana/web3.js";
import { PerkClient, MarketAccount, OracleSource } from "@perk/sdk";
import { fetchPrice, fetchPricesBatch } from "../feeds";
import { CrankerConfig } from "../config";
import { createLogger } from "../logger";
import { TxRateLimiter } from "../rate-limiter";

const log = createLogger("oracle");

interface OracleLoopState {
  running: boolean;
  consecutiveFailures: number;
  backoffMs: number;
}

export function startOracleLoop(
  client: PerkClient,
  markets: { address: PublicKey; account: MarketAccount }[],
  config: CrankerConfig,
  limiter?: TxRateLimiter,
): { stop: () => void } {
  const state: OracleLoopState = {
    running: true,
    consecutiveFailures: 0,
    backoffMs: 0,
  };

  log.info("Oracle loop starting", {
    intervalMs: config.oracleIntervalMs,
  });

  const tick = async (): Promise<void> => {
    // Re-derive PerkOracle markets each tick so market refresh is picked up
    const perkOracleMarkets = markets.filter(
      (m) => m.account.oracleSource === OracleSource.PerkOracle,
    );
    if (perkOracleMarkets.length === 0) return;

    const uniqueMints = new Map<string, PublicKey>();
    for (const m of perkOracleMarkets) {
      const mintStr = m.account.tokenMint.toBase58();
      if (!uniqueMints.has(mintStr)) {
        uniqueMints.set(mintStr, m.account.tokenMint);
      }
    }

    // Batch fetch all prices in 2 API calls (Jupiter + Birdeye)
    const allMints = Array.from(uniqueMints.keys());
    let batchPrices: Map<string, import("../feeds").AggregatedPrice>;
    try {
      batchPrices = await fetchPricesBatch(
        allMints,
        config.birdeyeApiKey,
        config.minPriceSources,
        config.maxDivergencePct,
        config.jupiterApiKey,
      );
    } catch (err) {
      log.error("Batch price fetch failed entirely", { error: String(err) });
      state.consecutiveFailures++;
      if (state.consecutiveFailures > 10) {
        log.error("Too many consecutive oracle failures — pausing 60s");
        await sleep(60_000);
        state.consecutiveFailures = 0;
      }
      return;
    }

    for (const [mintStr, tokenMint] of uniqueMints) {
      if (!state.running) return;

      const aggregated = batchPrices.get(mintStr);
      if (!aggregated) {
        log.warn("No price available for mint", { mint: mintStr });
        continue;
      }

      try {
        if (config.dryRun) {
          log.info("DRY RUN: would update oracle", {
            mint: mintStr,
            price: aggregated.price.toString(),
            confidence: aggregated.confidence.toString(),
            numSources: aggregated.numSources,
            sources: aggregated.sources.map((s) => `${s.name}=$${s.price}`),
          });
          continue;
        }

        // Fix 2: Rate limiter check
        if (limiter && !limiter.canSend()) {
          log.warn("Rate limit reached — skipping oracle update", { mint: mintStr });
          continue;
        }

        // Record rate limit BEFORE sending to avoid TOCTOU
        if (limiter) limiter.record();

        const sig = await client.updatePerkOracle(tokenMint, {
          price: aggregated.price,
          confidence: aggregated.confidence,
          numSources: aggregated.numSources,
        });

        log.info("Oracle updated", {
          mint: mintStr,
          price: aggregated.price.toString(),
          confidence: aggregated.confidence.toString(),
          numSources: aggregated.numSources,
          sig,
        });

        state.consecutiveFailures = 0;
        state.backoffMs = 0;
      } catch (err) {
        const errStr = String(err);
        // Handle known on-chain errors gracefully
        if (errStr.includes("OracleCircuitBreakerTripped")) {
          log.warn("Circuit breaker tripped — skipping update", { mint: mintStr });
          continue;
        }
        if (errStr.includes("PriceBandingExceeded")) {
          log.warn("Price banding rejected update", { mint: mintStr });
          continue;
        }

        state.consecutiveFailures++;
        log.error("Oracle update failed", {
          mint: mintStr,
          error: errStr,
          consecutiveFailures: state.consecutiveFailures,
        });

        if (state.consecutiveFailures > 10) {
          log.error("Too many consecutive oracle failures — pausing 60s");
          await sleep(60_000);
          state.consecutiveFailures = 0;
        }
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (state.running) {
      await tick();

      if (state.backoffMs > 0) {
        await sleep(state.backoffMs);
      } else {
        await sleep(config.oracleIntervalMs);
      }
    }
  };

  // Fix 3: Restart loop on crash instead of dying silently
  const runWithRestart = async (): Promise<void> => {
    while (state.running) {
      try {
        await loop();
      } catch (err) {
        log.error("Oracle loop crashed, restarting in 10s", { error: String(err) });
        await sleep(10_000);
      }
    }
  };
  runWithRestart().catch((err) => {
    log.error("Oracle loop fatal", { error: String(err) });
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
