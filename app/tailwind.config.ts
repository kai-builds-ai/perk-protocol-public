import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./src/app/**/*.{ts,tsx}",
    "./src/components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        bg: "#09090b",
        surface: "#0f0f11",
        border: "#2a2a30",
        "text-primary": "#fafafa",
        "text-secondary": "#71717a",
        "text-tertiary": "#3f3f46",
        profit: "#22c55e",
        "profit-muted": "#16a34a",
        loss: "#ef4444",
        "loss-muted": "#dc2626",
      },
      fontFamily: {
        mono: ["JetBrains Mono", "monospace"],
        sans: ["Space Grotesk", "sans-serif"],
      },
    },
  },
  plugins: [],
};

export default config;
