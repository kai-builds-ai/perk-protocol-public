"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.findProtocolAddress = findProtocolAddress;
exports.findMarketAddress = findMarketAddress;
exports.findPositionAddress = findPositionAddress;
exports.findVaultAddress = findVaultAddress;
exports.findPerkOracleAddress = findPerkOracleAddress;
exports.findTriggerOrderAddress = findTriggerOrderAddress;
const web3_js_1 = require("@solana/web3.js");
const bn_js_1 = __importDefault(require("bn.js"));
const constants_1 = require("./constants");
/** Derive the protocol PDA. */
function findProtocolAddress(programId = constants_1.PERK_PROGRAM_ID) {
    return web3_js_1.PublicKey.findProgramAddressSync([constants_1.PROTOCOL_SEED], programId);
}
/** Derive a market PDA from its token mint and creator. */
function findMarketAddress(tokenMint, creator, programId = constants_1.PERK_PROGRAM_ID) {
    return web3_js_1.PublicKey.findProgramAddressSync([constants_1.MARKET_SEED, tokenMint.toBuffer(), creator.toBuffer()], programId);
}
/** Derive a user position PDA. */
function findPositionAddress(market, user, programId = constants_1.PERK_PROGRAM_ID) {
    return web3_js_1.PublicKey.findProgramAddressSync([constants_1.POSITION_SEED, market.toBuffer(), user.toBuffer()], programId);
}
/** Derive the vault PDA for a market. */
function findVaultAddress(market, programId = constants_1.PERK_PROGRAM_ID) {
    return web3_js_1.PublicKey.findProgramAddressSync([constants_1.VAULT_SEED, market.toBuffer()], programId);
}
/** Derive the PerkOracle PDA for a token mint. */
function findPerkOracleAddress(tokenMint, programId = constants_1.PERK_PROGRAM_ID) {
    return web3_js_1.PublicKey.findProgramAddressSync([constants_1.PERK_ORACLE_SEED, tokenMint.toBuffer()], programId);
}
/** Derive a trigger order PDA. */
function findTriggerOrderAddress(market, user, orderId, programId = constants_1.PERK_PROGRAM_ID) {
    const orderIdBn = bn_js_1.default.isBN(orderId) ? orderId : new bn_js_1.default(orderId);
    return web3_js_1.PublicKey.findProgramAddressSync([
        constants_1.TRIGGER_SEED,
        market.toBuffer(),
        user.toBuffer(),
        orderIdBn.toArrayLike(Buffer, "le", 8),
    ], programId);
}
//# sourceMappingURL=pda.js.map