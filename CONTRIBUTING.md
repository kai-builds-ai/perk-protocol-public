# Contributing to Perk Protocol

Thanks for helping improve Perk. This document explains how to set up a dev environment, run checks locally, and open a pull request.

## Before you start

- Use a **fork** of [`kai-builds-ai/perk-protocol-public`](https://github.com/kai-builds-ai/perk-protocol-public), work on a branch, and open a PR back to `main`.
- For **security issues**, do not file a public issue. Follow [SECURITY.md](./SECURITY.md) instead.

## Prerequisites

- **Rust**: toolchain pinned in [rust-toolchain.toml](./rust-toolchain.toml) (install via [rustup](https://rustup.rs/)).
- **Anchor**: version aligned with the repo (see `anchor-lang` / `anchor-spl` in [programs/perk-protocol/Cargo.toml](./programs/perk-protocol/Cargo.toml)); [Anchor install guide](https://www.anchor-lang.com/docs/installation).
- **Node.js**: current LTS is fine for the SDK and app.

## Repository layout

| Path | Purpose |
|------|---------|
| `programs/perk-protocol/` | On-chain program (Rust / Anchor) |
| `sdk/` | TypeScript SDK (`@perk/sdk` on npm; local package name `perk-protocol` in package.json) |
| `app/` | Next.js trading UI |
| `cranker/` | Oracle / cranker tooling |
| `docs/`, `docs-site/` | Documentation |

## Building the on-chain program

From the repository root:

```bash
anchor build
```

Adjust `[provider]` in `Anchor.toml` only for your own local wallet and cluster; avoid committing personal paths or keys.

## Formal verification (Kani)

Changes under `programs/perk-protocol/src/**` or `programs/perk-protocol/tests/**` trigger the [Kani workflow](.github/workflows/kani.yml) on pull requests.

To run a single proof harness locally (after [installing Kani](https://model-checking.github.io/kani/install-guide.html)):

```bash
cd programs/perk-protocol
cargo kani --tests --harness <harness_name> --solver cadical --default-unwind 30 --no-unwinding-checks
```

See [PROOF-SPEC.md](./PROOF-SPEC.md) for the property spec and harness naming.

## SDK

```bash
cd sdk
npm install
npm run build
```

The app depends on the SDK via `"@perk/sdk": "file:../sdk"`, so build the SDK before running or building the frontend.

## App (frontend)

```bash
cd app
npm install
npm run dev
```

Use `npm run lint` before submitting UI or TypeScript changes in `app/`.

## Pull requests

- Keep the change focused and describe **what** changed and **why** in the PR body.
- If you touch program logic or proofs, expect the Kani CI jobs to run; fix any failures before merge.
- Match existing formatting (`cargo fmt`, project Prettier/eslint if you change JS/TS).

## License

By contributing, you agree your contributions will be licensed under the same terms as the project ([MIT](./LICENSE)).
