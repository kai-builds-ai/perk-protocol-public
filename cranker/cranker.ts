import "dotenv/config";
import { Connection, PublicKey, LAMPORTS_PER_SOL } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { PerkClient } from "@perk/sdk";
import { loadConfig, loadKeypair, CrankerConfig } from "./config";
import { createLogger, setLogLevel } from "./logger";
import { TxRateLimiter } from "./rate-limiter";
import { startOracleLoop } from "./loops/oracle";
import { startFundingLoop } from "./loops/funding";
import { startLiquidationLoop } from "./loops/liquidation";
import { startTriggersLoop } from "./loops/triggers";
import { startPegLoop } from "./loops/peg";

const log = createLogger("main");

interface LoopHandle {
  stop: () => void;
}

// Fix 3: Global running flag for graceful shutdown
let running = true;

async function main(): Promise<void> {
  // Load config
  const config = loadConfig();

  if (process.env.PERK_LOG_LEVEL) {
    setLogLevel(process.env.PERK_LOG_LEVEL as "debug" | "info" | "warn" | "error");
  }

  log.info("Perk Cranker starting", {
    rpcUrl: config.rpcUrl.replace(/\/\/.*@/, "//***@"), // mask auth in URL
    programId: config.programId,
    dryRun: config.dryRun,
  });

  // Load keypair and create client
  const keypair = loadKeypair(config.keypairPath);
  const wallet = new Wallet(keypair);
  const connection = new Connection(config.rpcUrl, "confirmed");
  const programId = new PublicKey(config.programId);

  const client = new PerkClient({
    connection,
    wallet,
    programId,
  });

  // Log wallet info
  const balance = await connection.getBalance(wallet.publicKey);
  log.info("Wallet loaded", {
    pubkey: wallet.publicKey.toBase58(),
    balanceSol: (balance / LAMPORTS_PER_SOL).toFixed(4),
  });

  if (balance < LAMPORTS_PER_SOL * 0.01) {
    log.warn("Wallet balance is very low — transactions may fail", {
      balanceSol: (balance / LAMPORTS_PER_SOL).toFixed(4),
    });
  }

  // Fix 2: Create shared rate limiter
  const limiter = new TxRateLimiter(config.maxTxPerMinute);

  // Fetch all markets — use mutable array for Fix 1 (periodic refresh)
  const markets = await client.fetchAllMarkets();
  const activeMarkets: { address: PublicKey; account: any }[] = markets.filter((m) => m.account.active);

  log.info("Markets loaded", {
    total: markets.length,
    active: activeMarkets.length,
    markets: activeMarkets.map((m) => ({
      address: m.address.toBase58(),
      tokenMint: m.account.tokenMint.toBase58(),
      oracleSource: m.account.oracleSource,
    })),
  });

  if (activeMarkets.length === 0) {
    log.warn("No active markets found — cranker will idle");
  }

  // Start loops (with rate limiter passed to each)
  const loops: LoopHandle[] = [];
  const enabledLoops: string[] = [];

  if (config.enableOracle) {
    loops.push(startOracleLoop(client, activeMarkets, config, limiter));
    enabledLoops.push("oracle");
  }
  if (config.enableFunding) {
    loops.push(startFundingLoop(client, activeMarkets, config, limiter));
    enabledLoops.push("funding");
  }
  if (config.enableLiquidation) {
    loops.push(startLiquidationLoop(client, activeMarkets, config, limiter));
    enabledLoops.push("liquidation");
  }
  if (config.enableTriggers) {
    loops.push(startTriggersLoop(client, activeMarkets, config, limiter));
    enabledLoops.push("triggers");
  }
  if (config.enablePeg) {
    loops.push(startPegLoop(client, activeMarkets, config, limiter));
    enabledLoops.push("peg");
  }

  log.info("All loops started", {
    enabledLoops,
    disabledLoops: ["oracle", "funding", "liquidation", "triggers", "peg"].filter(
      (l) => !enabledLoops.includes(l),
    ),
  });

  // Fix 1: Periodic market list refresh every 5 minutes
  const MARKET_REFRESH_MS = 5 * 60 * 1000;
  setInterval(async () => {
    try {
      const fresh = await client.fetchAllMarkets();
      const freshActive = fresh.filter((m) => m.account.active);
      // Atomic swap: splice replaces all elements in a single operation
      // This prevents loops from seeing an empty array mid-refresh
      activeMarkets.splice(0, activeMarkets.length, ...freshActive);
      log.info("Refreshed market list", { count: freshActive.length });
    } catch (err) {
      log.error("Failed to refresh markets", { error: String(err) });
    }
  }, MARKET_REFRESH_MS);

  // Graceful shutdown
  const shutdown = (): void => {
    log.info("Shutdown signal received — stopping all loops");
    running = false;
    for (const loop of loops) {
      loop.stop();
    }
    // Give loops time to finish current iteration
    setTimeout(() => {
      log.info("Cranker stopped");
      process.exit(0);
    }, 3000);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Keep process alive
  log.info("Cranker running — press Ctrl+C to stop");
}

main().catch((err) => {
  log.error("Fatal error", { error: String(err), stack: (err as Error).stack });
  process.exit(1);
});
