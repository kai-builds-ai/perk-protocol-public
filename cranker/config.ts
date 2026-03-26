import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

export interface CrankerConfig {
  rpcUrl: string;
  programId: string;
  keypairPath: string;
  birdeyeApiKey?: string;
  jupiterApiKey?: string;

  // Loop intervals (ms)
  oracleIntervalMs: number;
  fundingIntervalMs: number;
  liquidationIntervalMs: number;
  triggerIntervalMs: number;
  pegIntervalMs: number;

  // Feature flags
  enableOracle: boolean;
  enableFunding: boolean;
  enableLiquidation: boolean;
  enableTriggers: boolean;
  enablePeg: boolean;

  // Safety
  maxTxPerMinute: number;
  dryRun: boolean;

  // Price feed safety
  minPriceSources: number;      // minimum price sources required (default: 2)
  maxDivergencePct: number;     // max allowed divergence between sources (default: 0.05 = 5%)
}

function envBool(key: string, defaultValue: boolean): boolean {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  return val === "true" || val === "1";
}

function envInt(key: string, defaultValue: number): number {
  const val = process.env[key];
  if (val === undefined) return defaultValue;
  const parsed = parseInt(val, 10);
  if (isNaN(parsed)) {
    throw new Error(`Invalid integer for ${key}: ${val}`);
  }
  return parsed;
}

export function loadConfig(): CrankerConfig {
  const rpcUrl = process.env.PERK_RPC_URL;
  if (!rpcUrl) {
    throw new Error("PERK_RPC_URL is required");
  }

  const keypairPath = process.env.PERK_KEYPAIR_PATH ?? "";
  const keypairJson = process.env.PERK_KEYPAIR_JSON;
  if (!keypairPath && !keypairJson) {
    throw new Error("PERK_KEYPAIR_PATH or PERK_KEYPAIR_JSON is required");
  }

  const config: CrankerConfig = {
    rpcUrl,
    programId: process.env.PERK_PROGRAM_ID ?? "5mqYowuNCA8iKFjqn6XKA7vURuaKEUUmPK5QJiCbHyMW",
    keypairPath,
    birdeyeApiKey: process.env.BIRDEYE_API_KEY,
    jupiterApiKey: process.env.JUPITER_API_KEY,

    oracleIntervalMs: envInt("PERK_ORACLE_INTERVAL_MS", 10_000),
    fundingIntervalMs: envInt("PERK_FUNDING_INTERVAL_MS", 60_000),
    liquidationIntervalMs: envInt("PERK_LIQUIDATION_INTERVAL_MS", 2_000),
    triggerIntervalMs: envInt("PERK_TRIGGER_INTERVAL_MS", 1_000),
    pegIntervalMs: envInt("PERK_PEG_INTERVAL_MS", 10_000),

    enableOracle: envBool("PERK_ENABLE_ORACLE", true),
    enableFunding: envBool("PERK_ENABLE_FUNDING", true),
    enableLiquidation: envBool("PERK_ENABLE_LIQUIDATION", true),
    enableTriggers: envBool("PERK_ENABLE_TRIGGERS", true),
    enablePeg: envBool("PERK_ENABLE_PEG", true),

    maxTxPerMinute: envInt("PERK_MAX_TX_PER_MINUTE", 120),
    dryRun: envBool("PERK_DRY_RUN", false),

    minPriceSources: envInt("PERK_MIN_PRICE_SOURCES", 2),
    maxDivergencePct: parseFloat(process.env.PERK_MAX_DIVERGENCE_PCT ?? "0.05"),
  };

  // Validate config bounds — prevent config injection attacks
  const bounds: Array<[string, number, number, number]> = [
    ["oracleIntervalMs", config.oracleIntervalMs, 1_000, 300_000],
    ["fundingIntervalMs", config.fundingIntervalMs, 5_000, 600_000],
    ["liquidationIntervalMs", config.liquidationIntervalMs, 500, 60_000],
    ["triggerIntervalMs", config.triggerIntervalMs, 500, 60_000],
    ["pegIntervalMs", config.pegIntervalMs, 1_000, 300_000],
    ["maxTxPerMinute", config.maxTxPerMinute, 1, 1_000],
    ["minPriceSources", config.minPriceSources, 1, 10],
  ];
  for (const [name, val, min, max] of bounds) {
    if (val < min || val > max) {
      throw new Error(`${name} must be between ${min} and ${max}, got ${val}`);
    }
  }
  if (!Number.isFinite(config.maxDivergencePct) || config.maxDivergencePct <= 0 || config.maxDivergencePct > 1) {
    throw new Error(`maxDivergencePct must be between 0 and 1, got ${config.maxDivergencePct}`);
  }

  return config;
}

export function loadKeypair(keypairPath: string): Keypair {
  // Support PERK_KEYPAIR_JSON env var for cloud deployments (Railway, etc.)
  const keypairJson = process.env.PERK_KEYPAIR_JSON;
  if (keypairJson) {
    const secretKey = new Uint8Array(JSON.parse(keypairJson));
    return Keypair.fromSecretKey(secretKey);
  }

  if (!keypairPath) {
    throw new Error("No keypair path or PERK_KEYPAIR_JSON provided");
  }
  const resolved = path.resolve(keypairPath);
  const raw = fs.readFileSync(resolved, "utf-8");
  const secretKey = new Uint8Array(JSON.parse(raw));
  return Keypair.fromSecretKey(secretKey);
}
