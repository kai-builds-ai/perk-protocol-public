/**
 * Transaction simulation utilities.
 * Provides pre-flight simulation before sending transactions to avoid
 * users paying for failed transactions.
 *
 * Note: Anchor's sendAndConfirm already simulates by default (skipPreflight: false),
 * but this provides explicit simulation with user-friendly error messages
 * for cases where we build transactions manually.
 */

import { Connection, Transaction, VersionedTransaction } from "@solana/web3.js";
import { sanitizeError } from "./error-utils";

export interface SimulationResult {
  success: boolean;
  error?: string;
  logs?: string[];
}

/**
 * Simulate a transaction and return a user-friendly result.
 * Call this before sendTransaction for manually-built transactions.
 */
export async function simulateTransaction(
  connection: Connection,
  tx: Transaction | VersionedTransaction
): Promise<SimulationResult> {
  try {
    let result;
    if (tx instanceof Transaction) {
      result = await connection.simulateTransaction(tx);
    } else {
      result = await connection.simulateTransaction(tx);
    }

    if (result.value.err) {
      const logs = result.value.logs ?? [];
      // Extract meaningful error from logs
      const errorLog = logs.find(
        (l) => l.includes("Error") || l.includes("failed") || l.includes("insufficient")
      );
      return {
        success: false,
        error: errorLog
          ? sanitizeError(new Error(errorLog), "simulation")
          : "Transaction simulation failed. The transaction would not succeed.",
        logs,
      };
    }

    return { success: true, logs: result.value.logs ?? [] };
  } catch (err) {
    return {
      success: false,
      error: sanitizeError(err, "simulation"),
    };
  }
}
