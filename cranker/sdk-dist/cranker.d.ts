import { Connection, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
export interface CrankerConfig {
    connection: Connection;
    wallet: Wallet;
    /** Markets to crank (by address). If empty, cranks all active markets. */
    markets?: PublicKey[];
    /** Polling interval in ms (default: 5000). */
    pollIntervalMs?: number;
    /** Whether to run liquidations (default: true). */
    enableLiquidations?: boolean;
    /** Whether to crank funding (default: true). */
    enableFunding?: boolean;
    /** Whether to execute trigger orders (default: true). */
    enableTriggerOrders?: boolean;
    /** Whether to update AMM peg (default: true). */
    enablePegUpdate?: boolean;
    /** Whether to reclaim empty accounts (default: false). */
    enableReclaim?: boolean;
    /** Token account to receive liquidation/execution rewards. */
    rewardTokenAccount?: PublicKey;
    /** Priority fee in microlamports per compute unit (default: 0 = no priority fee). */
    priorityFeeMicroLamports?: number;
    /** Callback for logging. */
    onLog?: (msg: string) => void;
    /** Callback for errors. */
    onError?: (err: Error, context: string) => void;
    /** Callback for metrics (called per tick with stats). */
    onMetrics?: (metrics: CrankerMetrics) => void;
}
export interface CrankerMetrics {
    tickDurationMs: number;
    marketsProcessed: number;
    liquidationsAttempted: number;
    liquidationsSucceeded: number;
    triggerOrdersExecuted: number;
    fundingCranked: number;
    pegUpdates: number;
    reclaimsAttempted: number;
    errors: number;
}
export declare class PerkCranker {
    private client;
    private config;
    private running;
    private intervalId;
    private tickInProgress;
    /** Cache: collateral mint → ATA address for this wallet. */
    private ataCache;
    constructor(config: CrankerConfig);
    private log;
    private handleError;
    /** Start the cranker loop. */
    start(): void;
    /** Stop the cranker loop gracefully. Waits for current tick to finish (up to timeoutMs, default 30s). */
    stop(timeoutMs?: number): Promise<void>;
    /** Returns true if the cranker is currently running. */
    isRunning(): boolean;
    private tick;
    private _tickInner;
    private fetchMarkets;
    private fetchPositions;
    private fetchTriggerOrders;
    private getRewardAccount;
    private crankFunding;
    private updatePeg;
    private scanLiquidations;
    private scanTriggerOrders;
    private scanReclaims;
}
//# sourceMappingURL=cranker.d.ts.map