# $PERK Token

> **⚠️ Disclaimer:** Token utility features require on-chain implementation. Some features described below will launch after the token. All parameters — fee discount tiers, staking rates, emissions schedules — are subject to change. Governance is Phase 2; at launch, the protocol is admin-configurable.

---

## Overview

$PERK is the native SPL token of the Perk Protocol. It serves as the economic coordination layer for fee discounts, staking rewards, market creation incentives, and (in Phase 2) protocol governance.

| Property | Detail |
|---|---|
| Token standard | SPL (Solana) |
| Total supply | 1,000,000,000 (1 billion) |
| Launch | pump.fun fair launch |
| Presale | None |
| VC allocation | None |
| Team allocation | 20% (vested) |
| Treasury | 10% |

---

## Token Utility

### 1. Fee Discounts *(Phase 2)*

Holding $PERK in a connected wallet reduces trading fees across all Perk markets. Discounts are tiered by balance:

| Tier | $PERK Required | Fee Discount |
|---|---|---|
| 1 | 5,000 | 5% |
| 2 | 50,000 | 10% |
| 3 | 500,000 | 15% |
| 4 | 5,000,000 | 25% |

Discount applies to the `tradingFeeBps` charged on each trade. A market with a 0.1% fee and a Tier 4 holder pays 0.075%. Creator fee share (10% of collected fees) is calculated after the discount.

> **Note:** Tier thresholds and discount percentages are subject to change.

### 2. Staking Rewards *(Phase 2)*

Stake $PERK to earn a proportional share of protocol trading fees. Rewards are distributed from the protocol's fee accumulator to stakers based on their share of the total staked supply.

- Rewards accrue per epoch (duration TBD)
- Claim is permissionless — call at any time
- Unstaking has a cooldown period (TBD)

### 3. Market Creation Discount *(Phase 2)*

Market creation costs 1 SOL when paid in native SOL. Paying the equivalent in $PERK receives a 50% discount (0.5 SOL equivalent). The $PERK collected is routed to the protocol treasury.

### 4. Creator Staking *(Phase 2)*

Market creators can stake $PERK against their market to boost its visibility and ranking in the Perk UI. Staked amount determines sort weight in the market directory. This is a UI-level mechanism — it does not affect on-chain trading behavior.

Creator staking is especially relevant in multi-market competition. When multiple creators launch markets for the same token, staking $PERK is one of the primary ways to differentiate — higher stake means higher visibility in the UI, directing more trader flow to that market. Combined with competitive fee and leverage parameters, staking is how creators win market share.

### 5. Trading Rewards *(Phase 2)*

Active traders earn $PERK emissions proportional to their trading volume. Emissions follow a decay schedule to prevent inflationary spiral — early participants earn more per unit of volume than later ones.

> **Note:** Emissions schedule and decay curve are TBD.

### 6. Governance (Phase 2)

$PERK holders will vote on protocol parameters in Phase 2. Governance scope includes:

- Fee tier adjustments
- Leverage limits
- Insurance fund allocation rules
- Market curation (feature/delist markets in the UI)

At launch, all protocol parameters are admin-configurable. Governance transfer will occur after the protocol stabilizes and sufficient token distribution is achieved.

> **Important:** Market creation remains permissionless regardless of governance. Governance controls protocol-wide parameters, not individual market listing. Anyone can still create a market without a governance vote.

---

## What $PERK Is Not

- Not required to trade. Any user can trade on Perk without holding $PERK.
- Not required to create a market. Market creation is permissionless — $PERK only provides a fee discount.
- Not a claim on protocol assets. Staking rewards are distributed from fee accumulators, not from vault funds.

---

## Contract Details

| Field | Value |
|---|---|
| Chain | Solana |
| Standard | SPL Token |
| Launch platform | pump.fun |
| Total supply | 1,000,000,000 |
| Decimals | 6 |
| Mint authority | Revoked after launch |

---

## Links

- [Fees](09-fees.md) — Protocol fee structure and creator revenue
- [Market Creation](04-market-creation.md) — How to launch a market
- [FAQ](10-faq.md) — Common questions including $PERK
