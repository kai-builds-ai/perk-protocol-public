/**
 * Shared token metadata — single source of truth for mint → symbol/name mapping.
 * Replace with on-chain metadata resolution later.
 */
export const TOKEN_META: Record<string, { symbol: string; name: string; logoUrl?: string }> = {
  So11111111111111111111111111111111111111112: { symbol: "SOL", name: "Solana" },
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: { symbol: "BONK", name: "Bonk" },
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: { symbol: "WIF", name: "dogwifhat" },
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: { symbol: "JUP", name: "Jupiter" },
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: { symbol: "JTO", name: "Jito" },
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": { symbol: "RAY", name: "Raydium" },
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: { symbol: "ORCA", name: "Orca" },
};

export function getTokenSymbol(mint: string): string {
  return TOKEN_META[mint]?.symbol ?? mint.slice(0, 6);
}

export function getTokenName(mint: string): string {
  return TOKEN_META[mint]?.name ?? mint.slice(0, 8) + "…";
}

// M-03 fix: populate decimals for all known tokens
const TOKEN_DECIMALS: Record<string, number> = {
  So11111111111111111111111111111111111111112: 9,  // SOL
  DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263: 5,  // BONK
  EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm: 6,  // WIF
  JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN: 6,  // JUP
  jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL: 9,  // JTO
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R": 6,  // RAY
  orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE: 6,  // ORCA
  EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v: 6,  // USDC
  Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB: 6,  // USDT
  // Default for unknown PF tokens is 6 (pump.fun standard)
};

export function getTokenDecimals(mint: string): number {
  return TOKEN_DECIMALS[mint] ?? 6;
}
