# Security

Perk handles other people's money. The security work reflects that responsibility. This document covers what we did, how, and why.

All code is open source under the MIT license: [github.com/kai-builds-ai/perk-protocol-public](https://github.com/kai-builds-ai/perk-protocol-public)

---

## Formal Verification

The protocol's arithmetic and state transitions are verified using [Kani](https://github.com/model-checking/kani), a Rust model checker. Kani exhaustively explores all possible inputs within defined bounds — it doesn't sample, it proves.

Proofs cover seven categories:

| Category | What It Verifies |
|---|---|
| Arithmetic | Floor/ceil division, mul/div, signed operations, fee math — no overflow, no rounding errors that favor the wrong party |
| Safety / Conservation | Deposits, withdrawals, trades, and liquidations conserve vault balance. Funding cannot mint tokens. Capital never goes negative. |
| Invariants | State machine properties hold after every operation. Aggregates (total capital, total PnL) stay consistent. |
| Liveness | The system makes progress — resets finalize, bankruptcy paths route correctly, dust is cleared |
| Funding | Funding rate computation, clamping, settlement, K-delta correctness |
| Margin & Liquidation | Equity calculations, maintenance/initial margin checks, liquidation deficit computation |
| Engine functions | Settlement, profit conversion, OI tracking — end-to-end correctness |

These proofs run against the actual Rust code in `engine/`, not a simplified model.

---

## Fuzz Testing

Adversarial fuzz testing generates random sequences of operations (deposits, trades, liquidations, funding cranks, oracle updates) and checks invariants after each:

- Vault balance ≥ sum of all deposits minus all withdrawals
- No user's deposited capital goes negative
- Aggregate tracking (total OI, total capital, total PnL) stays consistent
- No panics, no overflows, no undefined behavior

---

## Audit Methodology

Seven internal review rounds across the on-chain program, SDK, cranker, and frontend. These are development team reviews, not independent third-party audits:

| Round | Scope | Method |
|---|---|---|
| 1 | On-chain engine (vAMM, risk, funding) | Line-by-line review, invariant analysis |
| 2 | Instructions (all user-facing) | Attack surface mapping, input validation |
| 3 | SDK + cranker | Integration correctness, serialization, error handling |
| 4 | Red team | Adversarial attack scenarios against the full stack |
| 5 | PerkOracle (on-chain + cranker) | Oracle-specific attack vectors |
| 6 | Frontend | Transaction construction, state management, UX safety |
| 7 | Post-integration | Full system review after all components wired together |

Each round follows the same process: review → findings → fixes → re-review → sign-off.

### Red Team Scenarios

The red team audit specifically tested:
- Flash loan → oracle manipulation → profit extraction
- Stale price exploitation (oracle goes down, attacker trades at favorable stale price)
- Liquidation manipulation via oracle sandwich
- vAMM peg update exploitation
- Dust deposit/withdrawal attacks
- Overflow in position math at extreme values
- Trigger order gaming (front-running execution)

---

## The Percolator

Perk's risk engine is a full port of [Anatoly Yakovenko's Percolator](https://github.com/aeyakovenko/percolator) — the risk engine designed by Solana's co-founder for perpetual futures.

During the porting process, we identified and reported an issue in the original Percolator codebase ([Issue #22](https://github.com/aeyakovenko/percolator/issues/22)): the liquidation path didn't correctly reset the warmup slope, which could allow a position to retain stale warmup state after liquidation. This was part of standard due diligence when adapting the code to our environment.

The fix is implemented in Perk's engine and verified by Kani proofs.

---

## Safety Rails

### Circuit Breaker

If the oracle detects abnormal price movement (deviation from EMA exceeding the configured threshold), the oracle rejects the update. This effectively pauses the market — no trades execute on prices that look wrong.

The circuit breaker is configurable per oracle:
- Disabled (0) for memecoins where extreme moves are normal
- 5% for major tokens
- 1% for stablecoins

### Oracle Security

Multiple layers protect against oracle manipulation:

| Layer | Protection |
|---|---|
| Multi-source aggregation | Median of 2+ independent sources (Jupiter, Birdeye) |
| Outlier rejection | Sources deviating beyond the configured threshold (default: 1%) from median are excluded |
| Staleness check | Prices older than 15 seconds are rejected |
| Confidence interval | High-spread prices are flagged |
| Rate limiting | Max 1 oracle update per Solana slot |
| Price banding | Configurable per-update rate-of-change limits |
| Sliding window | 3x band over 50-slot window catches sustained manipulation |
| Freeze mechanism | Admin can immediately halt any oracle |
| Fail-closed | Oracle failure → market pause. Never use a bad price. |

### Insurance Fund

Each market has an independent insurance fund:

- Funded by 50% of liquidation fees
- Absorbs bad debt before socialization kicks in
- Epoch-capped at 30% of balance per epoch (prevents drainage)
- Dynamic floor — insurance can't be fully depleted in a single event

### Warmup Window

New unrealized profit enters a warmup period (~400 seconds) before it becomes withdrawable. This prevents:

- Oracle manipulation → instant profit extraction
- Flash loan attacks that create and cash out paper profit in one block

### Global Pause

The protocol admin can emergency-pause the entire protocol. When paused:
- No new positions, no deposits
- Withdrawals and position closes still work (users can always exit)

This is a last-resort safety mechanism, not a regular operational tool.

---

## Key Separation

No single wallet controls everything:

| Wallet | Can Do | Cannot Do |
|---|---|---|
| Admin | Pause protocol, freeze oracles, update config | Access vaults, post prices |
| Oracle cranker | Post price updates | Access vaults, pause protocol, admin actions |
| Liquidation cranker | Execute liquidations, crank funding | Access vaults, post prices, admin actions |
| Fee collection | Receive protocol fees | Any protocol actions |

Compromise of the oracle cranker means bad prices (detectable, freezable) but not stolen funds. Compromise of the liquidation cranker means nothing — it has no special privileges beyond what any user has.

---

## Open Source

All code is public, all code is auditable:

- **On-chain program:** Rust/Anchor, deployed from verified build
- **SDK:** TypeScript, published as `perk-protocol`
- **Cranker:** TypeScript, included in the repository
- **Frontend:** Next.js, source available

Repository: [github.com/kai-builds-ai/perk-protocol-public](https://github.com/kai-builds-ai/perk-protocol-public)

License: MIT
