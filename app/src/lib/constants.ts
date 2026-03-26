export const COLORS = {
  bg: "#09090b",
  surface: "#0f0f11",
  border: "#1a1a1e",
  textPrimary: "#fafafa",
  textSecondary: "#71717a",
  textTertiary: "#3f3f46",
  profit: "#22c55e",
  profitMuted: "#16a34a",
  loss: "#ef4444",
  lossMuted: "#dc2626",
  yellow: "#eab308",
  blue: "#3b82f6",
} as const;

export const LEVERAGE_STEPS = [1, 2, 3, 5, 10, 15, 20] as const;

export const SOLANA_RPC = process.env.NEXT_PUBLIC_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=60b57283-2b78-4d4b-80b5-bb83495b0c09";
