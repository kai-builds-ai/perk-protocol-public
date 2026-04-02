import { PublicKey } from "@solana/web3.js";
import BN from "bn.js";

// Program ID
export const PERK_PROGRAM_ID = new PublicKey(
  "3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2"
);

// PDA Seeds
export const PROTOCOL_SEED = Buffer.from("protocol");
export const MARKET_SEED = Buffer.from("market");
export const POSITION_SEED = Buffer.from("position");
export const VAULT_SEED = Buffer.from("vault");
export const TRIGGER_SEED = Buffer.from("trigger");

// On-chain constants (mirrored from constants.rs)
export const MIN_LEVERAGE = 200; // 2x
export const MAX_LEVERAGE = 2000; // 20x
export const LEVERAGE_SCALE = 100;
export const MIN_TRADING_FEE_BPS = 3;
export const MAX_TRADING_FEE_BPS = 100; // 1%
export const DEFAULT_TRADING_FEE_BPS = 30; // 0.3%
export const LIQUIDATION_FEE_BPS = 100; // 1%
export const MAINTENANCE_MARGIN_BPS = 500; // 5%
export const CREATOR_FEE_SHARE_BPS = 1000; // 10%
export const PRICE_SCALE = 1_000_000;
export const POS_SCALE = 1_000_000;
export const ADL_ONE = 1_000_000;
export const K_SCALE = new BN("1000000000000"); // 1e12
export const MIN_INITIAL_K = new BN("10000000000000000000000000"); // 1e25
export const DEFAULT_MARKET_CREATION_FEE = 1_000_000_000; // 1 SOL in lamports
export const FUNDING_RATE_PRECISION = 1_000_000;
export const MAX_FUNDING_ITERATIONS = 50;
export const MAX_FUNDING_DT = 65535;
export const FUNDING_RATE_CAP_BPS = 50;
export const PEG_UPDATE_COOLDOWN_SLOTS = 100;
export const AMM_PEG_THRESHOLD_BPS = 50;
export const ORACLE_STALENESS_SECONDS = 15;
export const INSURANCE_EPOCH_SECONDS = 86400;
export const INSURANCE_EPOCH_CAP_BPS = 3000; // ATK-09: reduced from 5000
export const WARMUP_PERIOD_SLOTS = 1000;
export const MIN_REMAINING_POSITION_SIZE = 100;
export const MAX_TRIGGER_ORDER_AGE_SECONDS = 30 * 24 * 3600; // 30 days
export const DUST_THRESHOLD = 1000;
export const MIN_RECLAIM_DELAY_SLOTS = 1000;
export const MAX_TRIGGER_ORDERS = 8;
export const BPS_DENOMINATOR = 10_000;
export const MIN_NONZERO_MM_REQ = 10_000;
export const MIN_NONZERO_IM_REQ = 20_000;
export const LIQUIDATOR_SHARE_BPS = 5000;
export const TRIGGER_EXECUTION_FEE_BPS = 1;
export const MIN_DEPOSIT_AMOUNT = 1_000;
export const MIN_A_SIDE = 1_000;

export const PERK_ORACLE_SEED = Buffer.from("perk_oracle");

// PerkOracle bounds (mirrored from constants.rs)
export const MIN_ORACLE_STALENESS_SECONDS = 5;
export const MAX_ORACLE_STALENESS_SECONDS = 300;
export const MAX_MIN_SOURCES = 10;
export const MAX_ORACLE_PRICE = 1_000_000_000_000; // 1e12
export const MIN_PRICE_CHANGE_BPS = 100; // 1% minimum band when enabled
export const MAX_PRICE_CHANGE_BPS = 9999; // 99.99% cap
export const MIN_CIRCUIT_BREAKER_BPS = 500; // 5% minimum when enabled
export const MAX_CIRCUIT_BREAKER_BPS = 9999; // 99.99% cap
export const CIRCUIT_BREAKER_WINDOW_SLOTS = 50; // ~20 seconds
export const WINDOW_BAND_MULTIPLIER = 3; // Sliding window = 3x per-update band

// Pyth
export const PYTH_PROGRAM_ID = new PublicKey(
  "FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH"
);
export const PYTH_SOL_USD_FEED = new PublicKey(
  "H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG"
);
