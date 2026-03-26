# Formal Verification

## What is Kani?

[Kani](https://model-checking.github.io/kani/) is a model checker for Rust. It mathematically proves that code satisfies specified properties by exhaustively exploring all possible inputs — not sampling like fuzz testing, but complete verification within bounded domains.

## Proof Harnesses

This directory contains **117 Kani proof harnesses** covering the Perk Protocol's core logic:

| File | Scope |
|------|-------|
| `proofs_arithmetic.rs` | Checked math, overflow protection, scaling operations |
| `proofs_engine.rs` | vAMM pricing, mark price, fee calculations |
| `proofs_funding.rs` | Funding rate computation, epoch transitions |
| `proofs_instructions.rs` | Instruction validation, account constraints |
| `proofs_instructions_2.rs` | Additional instruction coverage (trigger orders, admin ops) |
| `proofs_invariants.rs` | Conservation laws, state consistency |
| `proofs_liveness.rs` | Progress guarantees, no deadlocks |
| `proofs_margin.rs` | Margin calculations, liquidation thresholds |
| `proofs_safety.rs` | No-panic guarantees, bounds checking |

## Running

Requires [Kani](https://model-checking.github.io/kani/getting-started/installation/) installed locally.

```sh
cargo kani --tests
```

Individual harness:

```sh
cargo kani --harness <harness_name>
```
