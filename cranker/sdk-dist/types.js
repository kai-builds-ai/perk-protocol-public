"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.TriggerOrderType = exports.SideState = exports.Side = exports.OracleSource = void 0;
// ── Enums ──
var OracleSource;
(function (OracleSource) {
    OracleSource[OracleSource["Pyth"] = 0] = "Pyth";
    OracleSource[OracleSource["PerkOracle"] = 1] = "PerkOracle";
    OracleSource[OracleSource["DexPool"] = 2] = "DexPool";
})(OracleSource || (exports.OracleSource = OracleSource = {}));
var Side;
(function (Side) {
    Side[Side["Long"] = 0] = "Long";
    Side[Side["Short"] = 1] = "Short";
})(Side || (exports.Side = Side = {}));
var SideState;
(function (SideState) {
    SideState[SideState["Normal"] = 0] = "Normal";
    SideState[SideState["DrainOnly"] = 1] = "DrainOnly";
    SideState[SideState["ResetPending"] = 2] = "ResetPending";
})(SideState || (exports.SideState = SideState = {}));
var TriggerOrderType;
(function (TriggerOrderType) {
    TriggerOrderType[TriggerOrderType["Limit"] = 0] = "Limit";
    TriggerOrderType[TriggerOrderType["StopLoss"] = 1] = "StopLoss";
    TriggerOrderType[TriggerOrderType["TakeProfit"] = 2] = "TakeProfit";
})(TriggerOrderType || (exports.TriggerOrderType = TriggerOrderType = {}));
//# sourceMappingURL=types.js.map