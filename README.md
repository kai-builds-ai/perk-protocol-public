# Perk Protocol

**Permissionless perpetual futures on Solana.**

Anyone can create a leveraged market for any SPL token. Market creators earn 10% of all trading fees forever.

## Architecture

```
programs/perk-protocol/   Anchor on-chain program (Rust)
├── src/engine/           Risk engine — full port of Percolator
├── src/instructions/     20 instruction handlers
├── src/state/            Market, UserPosition, Protocol, TriggerOrder
└── tests/                117 Kani formal verification proofs

sdk/                      TypeScript SDK (@perk/sdk)
├── src/                  Client, instructions, math, cranker, types
└── tests/                E2E devnet integration tests

app/                      Next.js trading terminal
├── src/app/              Pages (trade, markets, create)
├── src/components/       UI components
└── public/               Static assets
```

## Key Features

- **Permissionless markets** — create a perp market for any SPL token with Pyth oracle support
- **vAMM pricing** — virtual AMM (x\*y=k) with no order book needed
- **Formal verification** — 117 Kani CBMC proofs covering math, safety, conservation, margins, funding, and full instruction composition
- **Percolator risk engine** — ported from [Anatoly Yakovenko's reference implementation](https://github.com/aeyakovenko/percolator)
- **Auto-deleveraging (ADL)** — socialized loss mechanism with insurance fund priority
- **Trigger orders** — stop-loss and take-profit with keeper execution

## Formal Verification

117 proofs across 9 test files, verified with [Kani](https://github.com/model-checking/kani):

| Category | Proofs | What it covers |
|----------|--------|----------------|
| Arithmetic | 15 | U256/I256 math, mul_div, rounding correctness |
| Safety | 20 | Conservation laws, no-mint funding, insurance bounds |
| Margin | 29 | Equity calculations, IM/MM thresholds, liquidation triggers |
| Invariants | 11 | Aggregate tracking, warmup bounds |
| Funding | 9 | K-index deltas, rate clamping, zero-sum property |
| Liveness | 6 | Reset finalization, terminal drain, bankruptcy handling |
| Engine | 10 | Previously unproven function coverage |
| Instructions | 9 | Deposit/withdraw/open/close composition + lifecycle |
| Instructions₂ | 8 | Liquidation/funding crank/reclaim/fees/two-user zero-sum |

**Status: 117/117 verified.** All inputs symbolic with bounded `kani::assume()`. Production-scale constants. Zero vacuous proofs. Zero verification failures. See [PROOF-SPEC.md](./PROOF-SPEC.md) for the full property specification.

## Stack

- **On-chain:** Rust + Anchor
- **Oracles:** Pyth Network (SOL/USD, BONK, WIF, JUP, JTO, RAY, ORCA)
- **SDK:** TypeScript + BN.js (safety-critical math)
- **Frontend:** Next.js 14 + Tailwind CSS
- **Design:** Bloomberg Terminal meets Hyperliquid — JetBrains Mono + Space Grotesk

## Program

Deployed to devnet: `5mqYowuNCA8iKFjqn6XKA7vURuaKEUUmPK5QJiCbHyMW`

## License

Proprietary. All rights reserved.
