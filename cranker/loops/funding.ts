import { PublicKey } from "@solana/web3.js";
import { PerkClient, MarketAccount } from "@perk/sdk";
import { CrankerConfig } from "../config";
import { createLogger } from "../logger";
import { TxRateLimiter } from "../rate-limiter";

const log = createLogger("funding");

interface FundingLoopState {
  running: boolean;
  consecutiveFailures: number;
}

export function startFundingLoop(
  client: PerkClient,
  markets: { address: PublicKey; account: MarketAccount }[],
  config: CrankerConfig,
  limiter?: TxRateLimiter,
): { stop: () => void } {
  const state: FundingLoopState = {
    running: true,
    consecutiveFailures: 0,
  };

  log.info("Funding loop starting", {
    marketCount: markets.length,
    intervalMs: config.fundingIntervalMs,
  });

  const tick = async (): Promise<void> => {
    const now = Math.floor(Date.now() / 1000);

    for (const { address, account } of markets) {
      if (!state.running) return;
      if (!account.active) continue;

      try {
        const lastFunding = account.lastFundingTime.toNumber();
        const period = account.fundingPeriodSeconds;
        const nextFundingTime = lastFunding + period;

        if (nextFundingTime >= now) {
          continue; // Not due yet
        }

        // Re-fetch market to get fresh lastFundingTime (avoid double-cranking)
        const freshMarket = await client.fetchMarketByAddress(address);
        const freshLastFunding = freshMarket.lastFundingTime.toNumber();
        if (freshLastFunding + freshMarket.fundingPeriodSeconds >= now) {
          continue;
        }

        const oracleAddress = freshMarket.oracleAddress;
        const fallbackOracle = freshMarket.fallbackOracleAddress;

        if (config.dryRun) {
          log.info("DRY RUN: would crank funding", {
            market: address.toBase58(),
            lastFunding: freshLastFunding,
            overdueSec: now - (freshLastFunding + freshMarket.fundingPeriodSeconds),
          });
          continue;
        }

        // Fix 2: Rate limiter check
        if (limiter && !limiter.canSend()) {
          log.warn("Rate limit reached — skipping funding crank", { market: address.toBase58() });
          continue;
        }

        // Record rate limit BEFORE sending to avoid TOCTOU
        if (limiter) limiter.record();

        const sig = await client.crankFunding(
          address,
          oracleAddress,
          fallbackOracle.equals(PublicKey.default) ? undefined : fallbackOracle,
        );

        log.info("Funding cranked", {
          market: address.toBase58(),
          sig,
          overdueSec: now - nextFundingTime,
        }, address.toBase58());

        state.consecutiveFailures = 0;
      } catch (err) {
        state.consecutiveFailures++;
        log.error("Funding crank failed", {
          market: address.toBase58(),
          error: String(err),
          consecutiveFailures: state.consecutiveFailures,
        }, address.toBase58());

        if (state.consecutiveFailures > 10) {
          log.error("Too many consecutive funding failures — pausing 60s");
          await sleep(60_000);
          state.consecutiveFailures = 0;
        }
      }
    }
  };

  const loop = async (): Promise<void> => {
    while (state.running) {
      await tick();
      await sleep(config.fundingIntervalMs);
    }
  };

  // Fix 3: Restart loop on crash instead of dying silently
  const runWithRestart = async (): Promise<void> => {
    while (state.running) {
      try {
        await loop();
      } catch (err) {
        log.error("Funding loop crashed, restarting in 10s", { error: String(err) });
        await sleep(10_000);
      }
    }
  };
  runWithRestart().catch((err) => {
    log.error("Funding loop fatal", { error: String(err) });
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
