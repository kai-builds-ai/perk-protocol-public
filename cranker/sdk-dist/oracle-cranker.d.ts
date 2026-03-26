import { Connection, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
export interface OracleCrankerConfig {
    connection: Connection;
    wallet: Wallet;
    /** Token mints to post prices for. */
    tokenMints: PublicKey[];
    /** Update interval in ms (default: 3000 — ~every 7-8 slots). */
    updateIntervalMs?: number;
    /** Birdeye API key (optional — if not provided, skip Birdeye source). */
    birdeyeApiKey?: string;
    /** Priority fee in microlamports per CU (default: 50000). */
    priorityFeeMicroLamports?: number;
    /** Max deviation between sources before rejecting an outlier (default: 0.01 = 1%).
     *  Must be ≤ half of on-chain ORACLE_CONFIDENCE_BPS (2%) because confidence = max-min,
     *  so two sources at ±X% produce 2X% confidence. 1% deviation → max 2% confidence → passes. */
    maxSourceDeviationPct?: number;
    /** Minimum number of valid sources required (should match on-chain min_sources).
     *  Default: 1 (since Raydium is stubbed, requiring 2 would deadlock when one API is down). */
    minSources?: number;
    /** HTTP fetch timeout in ms (default: 5000). Prevents hung connections from freezing the cranker. */
    fetchTimeoutMs?: number;
    /** Jito bundle configuration. If provided, oracle updates are submitted as private Jito bundles
     *  to prevent front-running / MEV extraction on oracle price updates. */
    jito?: {
        /** Jito Block Engine URL (default: mainnet). */
        blockEngineUrl?: string;
        /** Tip in lamports to include in the bundle (default: 10000 = 0.00001 SOL). */
        tipLamports?: number;
        /** If true, do NOT fall back to normal RPC when Jito fails. Prevents mempool leakage
         *  at the cost of missed updates when Jito is down. Default: false. */
        jitoOnly?: boolean;
    };
    /** Callback for logging. */
    onLog?: (msg: string) => void;
    /** Callback for errors. */
    onError?: (err: Error, context: string) => void;
    /** Callback for metrics. */
    onMetrics?: (metrics: OracleCrankerMetrics) => void;
}
export interface OracleCrankerMetrics {
    tickDurationMs: number;
    mintsProcessed: number;
    updatesPosted: number;
    sourcesFetched: number;
    outlierRejections: number;
    errors: number;
}
export declare class PerkOracleCranker {
    private client;
    private config;
    private running;
    private intervalId;
    private tickInProgress;
    constructor(config: OracleCrankerConfig);
    /**
     * Submit a transaction as a Jito bundle for private, front-run-resistant submission.
     * Falls back to normal RPC submission if Jito fails.
     */
    private sendViaJito;
    private log;
    private handleError;
    /** Start the oracle cranker loop. */
    start(): void;
    /** Stop the oracle cranker loop gracefully. Waits for current tick to finish (up to timeoutMs, default 30s). */
    stop(timeoutMs?: number): Promise<void>;
    /** Returns true if the oracle cranker is currently running. */
    isRunning(): boolean;
    private tick;
    private _tickInner;
}
//# sourceMappingURL=oracle-cranker.d.ts.map