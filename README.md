# Perk Protocol

Permissionless perpetual futures on Solana.

Perk is a fully on-chain perpetual futures protocol. Any token pair, any leverage, no permissions required. The risk engine is forked from [aeyakovenko/percolator](https://github.com/aeyakovenko/percolator) and extended with a custom oracle system, trigger orders, and automated liquidation.

```
117 Kani formal proofs  ·  5.9B fuzz iterations  ·  0 critical findings across 13 audits
```

## Architecture

The protocol is a single Anchor program with three layers:

- **State** — on-chain accounts: markets, positions, trigger orders, protocol config, oracle feeds
- **Engine** — pure computation: vAMM pricing, funding rate calculations, risk/margin checks, oracle aggregation, liquidation math
- **Instructions** — entry points: open/close positions, deposit/withdraw collateral, place/cancel/execute trigger orders, crank funding, admin operations

The oracle subsystem (`PerkOracle`) runs independently — crankers push price updates on-chain with staleness checks, confidence banding, and automatic freeze/unfreeze logic.

## Program

```
Program ID:  5mqYowuNCA8iKFjqn6XKA7vURuaKEUUmPK5QJiCbHyMW  (devnet)
Framework:   Anchor
Language:    Rust
```

## Build

```sh
anchor build
```

Requires Solana CLI and Anchor. See `rust-toolchain.toml` for the pinned Rust version.

## Verification

Formal verification uses [Kani](https://model-checking.github.io/kani/), a Rust model checker. The `proofs/` directory contains 117 harnesses covering arithmetic safety, engine correctness, funding invariants, margin calculations, instruction validation, and liveness/safety properties.

```sh
cargo kani --tests
```

## Repository Structure

```
programs/perk-protocol/src/   Anchor program source
proofs/                       117 Kani formal verification harnesses
audits/                       13 final-round security audit reports
idl/                          Anchor IDL (JSON)
```

## Audits

See [`audits/README.md`](audits/README.md) for the full audit matrix. Covers the on-chain program, SDK, cranker, oracle, and frontend wiring across multiple independent review rounds.

## Links

- **Protocol:** [perk.fund](https://perk.fund)
- **Documentation:** [docs.perk.fund](https://docs.perk.fund)
- **npm:** [`perk-protocol`](https://www.npmjs.com/package/perk-protocol)

## Security

Report vulnerabilities to **contact@perk.fund**. See [`SECURITY.md`](SECURITY.md).

## License

[MIT](LICENSE)
