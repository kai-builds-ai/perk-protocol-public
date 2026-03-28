/**
 * Sanitize on-chain/RPC error messages for user-facing display.
 * Never expose raw error objects, stack traces, or internal details.
 */

const ERROR_MAP: Array<{ pattern: RegExp | string; message: string }> = [
  { pattern: /insufficient funds/i, message: "Insufficient balance for this transaction." },
  { pattern: /insufficient lamports/i, message: "Not enough SOL to cover transaction fees." },
  { pattern: /slippage/i, message: "Price moved too much. Try again or increase slippage tolerance." },
  { pattern: /user rejected/i, message: "Transaction was rejected in your wallet." },
  { pattern: /User rejected the request/i, message: "Transaction was rejected in your wallet." },
  { pattern: /Transaction was not confirmed/i, message: "Transaction timed out. It may still confirm — check your wallet." },
  { pattern: /blockhash not found/i, message: "Transaction expired. Please try again." },
  { pattern: /already in use/i, message: "Account already exists. Please try again." },
  { pattern: /AccountNotFound/i, message: "Account not found. It may not be initialized yet." },
  { pattern: /Node is behind/i, message: "Network is congested. Please try again in a moment." },
  { pattern: /rate limit/i, message: "Too many requests. Please wait a moment and try again." },
  { pattern: /Simulation failed/i, message: "Transaction simulation failed. The transaction would not succeed." },
  { pattern: /0x1$/, message: "Insufficient funds for this operation." },
  { pattern: /0x0$/, message: "Transaction failed. Please try again." },
  { pattern: /custom program error/i, message: "Transaction failed due to a program error. Please try again." },
  { pattern: /Attempt to debit an account/i, message: "Insufficient balance for this transaction." },
  { pattern: /paused/i, message: "The protocol is currently paused." },
  { pattern: /WalletNotConnectedError/i, message: "Please connect your wallet first." },
  { pattern: /WalletSignTransactionError/i, message: "Failed to sign the transaction. Please try again." },
];

/**
 * Convert a raw error into a user-friendly message.
 * Logs the full error to console for debugging.
 */
export function sanitizeError(err: unknown, context?: string): string {
  const raw = err instanceof Error ? err.message : String(err);

  // Log full error for debugging (stripped in production by minifier dead code)
  // Always log full error for debugging (no sensitive data in tx errors)
  console.error(`[${context ?? "error"}] transaction failed:`, raw, '| full:', err);

  // Check against known patterns
  for (const { pattern, message } of ERROR_MAP) {
    if (typeof pattern === "string") {
      if (raw.includes(pattern)) return message;
    } else {
      if (pattern.test(raw)) return message;
    }
  }

  // Generic fallback — never expose the raw message
  return "Transaction failed. Please try again.";
}
