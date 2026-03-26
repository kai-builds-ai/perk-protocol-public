"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MAX_PRICE_CHANGE_BPS = exports.MIN_PRICE_CHANGE_BPS = exports.MAX_ORACLE_PRICE = exports.MAX_MIN_SOURCES = exports.MAX_ORACLE_STALENESS_SECONDS = exports.MIN_ORACLE_STALENESS_SECONDS = exports.PERK_ORACLE_SEED = exports.MIN_A_SIDE = exports.MIN_DEPOSIT_AMOUNT = exports.TRIGGER_EXECUTION_FEE_BPS = exports.LIQUIDATOR_SHARE_BPS = exports.MIN_NONZERO_IM_REQ = exports.MIN_NONZERO_MM_REQ = exports.BPS_DENOMINATOR = exports.MAX_TRIGGER_ORDERS = exports.MIN_RECLAIM_DELAY_SLOTS = exports.DUST_THRESHOLD = exports.MAX_TRIGGER_ORDER_AGE_SECONDS = exports.MIN_REMAINING_POSITION_SIZE = exports.WARMUP_PERIOD_SLOTS = exports.INSURANCE_EPOCH_CAP_BPS = exports.INSURANCE_EPOCH_SECONDS = exports.ORACLE_STALENESS_SECONDS = exports.AMM_PEG_THRESHOLD_BPS = exports.PEG_UPDATE_COOLDOWN_SLOTS = exports.FUNDING_RATE_CAP_BPS = exports.MAX_FUNDING_DT = exports.MAX_FUNDING_ITERATIONS = exports.FUNDING_RATE_PRECISION = exports.DEFAULT_MARKET_CREATION_FEE = exports.MIN_INITIAL_K = exports.K_SCALE = exports.ADL_ONE = exports.POS_SCALE = exports.PRICE_SCALE = exports.CREATOR_FEE_SHARE_BPS = exports.MAINTENANCE_MARGIN_BPS = exports.LIQUIDATION_FEE_BPS = exports.DEFAULT_TRADING_FEE_BPS = exports.MAX_TRADING_FEE_BPS = exports.MIN_TRADING_FEE_BPS = exports.LEVERAGE_SCALE = exports.MAX_LEVERAGE = exports.MIN_LEVERAGE = exports.TRIGGER_SEED = exports.VAULT_SEED = exports.POSITION_SEED = exports.MARKET_SEED = exports.PROTOCOL_SEED = exports.PERK_PROGRAM_ID = void 0;
exports.PYTH_SOL_USD_FEED = exports.PYTH_PROGRAM_ID = exports.WINDOW_BAND_MULTIPLIER = exports.CIRCUIT_BREAKER_WINDOW_SLOTS = exports.MAX_CIRCUIT_BREAKER_BPS = exports.MIN_CIRCUIT_BREAKER_BPS = void 0;
const web3_js_1 = require("@solana/web3.js");
const bn_js_1 = __importDefault(require("bn.js"));
// Program ID
exports.PERK_PROGRAM_ID = new web3_js_1.PublicKey("5mqYowuNCA8iKFjqn6XKA7vURuaKEUUmPK5QJiCbHyMW");
// PDA Seeds
exports.PROTOCOL_SEED = Buffer.from("protocol");
exports.MARKET_SEED = Buffer.from("market");
exports.POSITION_SEED = Buffer.from("position");
exports.VAULT_SEED = Buffer.from("vault");
exports.TRIGGER_SEED = Buffer.from("trigger");
// On-chain constants (mirrored from constants.rs)
exports.MIN_LEVERAGE = 200; // 2x
exports.MAX_LEVERAGE = 2000; // 20x
exports.LEVERAGE_SCALE = 100;
exports.MIN_TRADING_FEE_BPS = 3;
exports.MAX_TRADING_FEE_BPS = 100; // 1%
exports.DEFAULT_TRADING_FEE_BPS = 30; // 0.3%
exports.LIQUIDATION_FEE_BPS = 100; // 1%
exports.MAINTENANCE_MARGIN_BPS = 500; // 5%
exports.CREATOR_FEE_SHARE_BPS = 1000; // 10%
exports.PRICE_SCALE = 1000000;
exports.POS_SCALE = 1000000;
exports.ADL_ONE = 1000000;
exports.K_SCALE = new bn_js_1.default("1000000000000"); // 1e12
exports.MIN_INITIAL_K = new bn_js_1.default("1000000000000000000"); // 1e18
exports.DEFAULT_MARKET_CREATION_FEE = 1000000000; // 1 SOL in lamports
exports.FUNDING_RATE_PRECISION = 1000000;
exports.MAX_FUNDING_ITERATIONS = 50;
exports.MAX_FUNDING_DT = 65535;
exports.FUNDING_RATE_CAP_BPS = 10;
exports.PEG_UPDATE_COOLDOWN_SLOTS = 100;
exports.AMM_PEG_THRESHOLD_BPS = 50;
exports.ORACLE_STALENESS_SECONDS = 15;
exports.INSURANCE_EPOCH_SECONDS = 86400;
exports.INSURANCE_EPOCH_CAP_BPS = 3000; // ATK-09: reduced from 5000
exports.WARMUP_PERIOD_SLOTS = 1000;
exports.MIN_REMAINING_POSITION_SIZE = 100;
exports.MAX_TRIGGER_ORDER_AGE_SECONDS = 30 * 24 * 3600; // 30 days
exports.DUST_THRESHOLD = 1000;
exports.MIN_RECLAIM_DELAY_SLOTS = 1000;
exports.MAX_TRIGGER_ORDERS = 8;
exports.BPS_DENOMINATOR = 10000;
exports.MIN_NONZERO_MM_REQ = 10000;
exports.MIN_NONZERO_IM_REQ = 20000;
exports.LIQUIDATOR_SHARE_BPS = 5000;
exports.TRIGGER_EXECUTION_FEE_BPS = 1;
exports.MIN_DEPOSIT_AMOUNT = 1000;
exports.MIN_A_SIDE = 1000;
exports.PERK_ORACLE_SEED = Buffer.from("perk_oracle");
// PerkOracle bounds (mirrored from constants.rs)
exports.MIN_ORACLE_STALENESS_SECONDS = 5;
exports.MAX_ORACLE_STALENESS_SECONDS = 300;
exports.MAX_MIN_SOURCES = 10;
exports.MAX_ORACLE_PRICE = 1000000000000; // 1e12
exports.MIN_PRICE_CHANGE_BPS = 100; // 1% minimum band when enabled
exports.MAX_PRICE_CHANGE_BPS = 9999; // 99.99% cap
exports.MIN_CIRCUIT_BREAKER_BPS = 500; // 5% minimum when enabled
exports.MAX_CIRCUIT_BREAKER_BPS = 9999; // 99.99% cap
exports.CIRCUIT_BREAKER_WINDOW_SLOTS = 50; // ~20 seconds
exports.WINDOW_BAND_MULTIPLIER = 3; // Sliding window = 3x per-update band
// Pyth
exports.PYTH_PROGRAM_ID = new web3_js_1.PublicKey("FsJ3A3u2vn5cTVofAjvy6y5kwABJAqYWpe4975bi2epH");
exports.PYTH_SOL_USD_FEED = new web3_js_1.PublicKey("H6ARHf6YXhGYeQfUzQNGk6rDNnLBQKrenN712K4AQJEG");
//# sourceMappingURL=constants.js.map