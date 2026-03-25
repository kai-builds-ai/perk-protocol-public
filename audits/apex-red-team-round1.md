# PerkOracle Red Team Report — Apex Style (Round 1)

**Date:** March 25, 2026  
**Auditor:** Apex-style DeFi Red Team (automated)  
**Scope:** Full protocol — PerkOracle, risk engine (Percolator), vAMM, funding, liquidation, margin, deposit/withdraw  
**Methodology:** Source-code driven attack scenario analysis. Assume attacker has unlimited capital and sophisticated infrastructure (validator access, MEV extraction, multi-account coordination).

---

## Executive Summary

**Can the protocol be drained?** Not in a single atomic transaction. The Percolator risk engine (warmup, haircut, conservation checks, ADL) creates layered defenses that prevent instant vault drainage. However, **a compromised cranker key on an unbanded memecoin market is the single most dangerous vector**, enabling a multi-block attack that could extract the full vault TVL of that market over ~10-30 seconds.

**Max loss scenario:** A compromised PerkOracle cranker on a memecoin market (banding = 0) can post arbitrary prices. Combined with pre-positioned trades, the attacker could extract up to **100% of the market's vault balance** minus insurance floor. For banded major-token markets, the damage is rate-limited to ~41%/3s worst case, giving admin ~5-10 seconds to freeze.

**Overall risk posture:** The protocol has excellent defense-in-depth — warmup, haircuts, conservation invariants, insurance caps, ADL, and staleness checks form a strong multi-layer shield. The weakest link is the off-chain cranker trust model for unbanded markets. The protocol is **not systemically drainable** under normal operations but has **bounded extractable value** under specific compromise scenarios.

---

## Attack Scenario Analysis

### [ATK-01] Compromised Cranker Key — Unbanded Market (Memecoin)

**Category:** Oracle  
**Severity:** Critical  
**Feasibility:** Practical (requires cranker key compromise)  
**Max Extractable Value:** 100% of market vault balance minus insurance floor

**Attack Flow:**
1. Attacker compromises the oracle authority private key (server breach, leaked env var, social engineering)
2. Attacker opens a max-leverage long position on a memecoin market with `max_price_change_bps = 0` (no banding)
3. Attacker posts an oracle price 100x higher than real price via `update_perk_oracle` — passes all on-chain checks because banding is disabled
4. In the same or next slot, attacker calls `close_position` — K-diff settlement computes massive positive PnL
5. Warmup converts reserved_pnl (but if the warmup period has partly elapsed from earlier trades, or if the attacker pre-positioned with a series of small profitable trades to build up released PnL, partial extraction is immediate)
6. Alternatively: attacker's massive price spike triggers liquidation cascades on opposing positions, draining their collateral through enqueue_adl deficit socialization. The attacker's side receives the deficit-funded K-coefficient gains.
7. Attacker withdraws

**Critical detail:** The 1-slot holding period (H4 Pashov3 fix) prevents closing in the same slot, but the next slot (~400ms later) is sufficient. Warmup reserves new PnL, but the attacker can drain opposing positions via cascading liquidations in a single transaction — liquidation is permissionless and doesn't require the attacker to close their own position.

**Current Defenses:**
- Key isolation (oracle authority ≠ admin ≠ liquidation cranker)
- Monthly key rotation
- Admin `freeze_perk_oracle` emergency response
- Warmup period on profits (1000 slots ≈ 400 seconds)
- Insurance fund with per-epoch cap (50%/24h)
- Conservation invariant check on close/liquidate

**Defense Gaps:**
- No banding on memecoin markets by design — cranker has unlimited price authority
- Time from compromise to detection is likely > 1 second, enough for damage
- No on-chain circuit breaker (automatic price-move halt)
- The cranker can post updates every slot (~400ms), faster than any human admin response
- Warmup doesn't protect opposing positions from being liquidated at the fake price

**Recommendation:**
1. **CRITICAL:** Implement an on-chain circuit breaker — if oracle price moves > X% from EMA within Y slots, automatically pause the market (no admin action needed). This is the single highest-impact improvement.
2. Consider requiring min banding even for memecoins (e.g., 2000 bps = 20% per update) — legitimate 1000% pumps would take ~12 updates (5 seconds), but manipulation becomes rate-limited.
3. Add a time-delay on large withdrawals (e.g., > 50% of vault TVL requires N-slot delay).
4. Consider multi-sig or threshold signature for oracle authority on high-TVL markets.

---

### [ATK-02] Price Banding Slow Walk (Banded Markets)

**Category:** Oracle  
**Severity:** High  
**Feasibility:** Practical (requires cranker key compromise)  
**Max Extractable Value:** ~41%/3s for 500 bps banding (SOL/BTC/ETH); compounding: ~339% over 10 seconds

**Attack Flow:**
1. Attacker compromises cranker key on a market with `max_price_change_bps = 500` (5% per update)
2. Attacker pre-positions a large leveraged trade
3. Attacker posts sequential oracle updates, each moving price exactly 5% in the desired direction
4. One update per slot (400ms), so in ~7.5 slots (3 seconds): 1.05^7.5 ≈ 1.44 (44% total move)
5. Over 25 slots (10 seconds): 1.05^25 ≈ 3.39 (239% move)
6. Each update passes the banding check individually — the banding only looks at the delta from the *current stored price*, not from a reference window

**Current Defenses:**
- Price banding limits each individual update
- EMA tracking (but EMA is non-critical, not consumed by any instruction)
- Admin freeze capability

**Defense Gaps:**
- Banding is per-update, not per-time-window. There is no "max 10% move in 60 seconds" type check
- EMA is explicitly marked as non-critical and not used in any validation
- By the time admin detects and freezes (~10+ seconds minimum for human response), the price has been walked far enough to extract significant value

**Recommendation:**
1. Implement a **sliding window band** — track max/min oracle price over the last N slots and reject updates outside a window relative to that range
2. Use EMA as a secondary banding reference — reject updates that deviate > Y% from EMA (not just from last price)
3. Add automated alerting: if N consecutive updates all hit the banding limit in the same direction, auto-freeze

---

### [ATK-03] Freeze/Unfreeze Cycle Abuse

**Category:** Oracle  
**Severity:** Low  
**Feasibility:** Unlikely (requires admin collusion)  
**Max Extractable Value:** Limited by banding post-unfreeze

**Attack Flow:**
1. Admin freezes oracle (storing pre-freeze price in `_reserved[3..11]`)
2. Admin unfreezes — price is zeroed, `unfreeze_pending = 1`
3. First post-unfreeze update bypasses gap check but IS banded against the pre-freeze price (C-01 fix)
4. Subsequent updates resume normal banding from the new price

**Analysis:** The C-01 fix effectively closes this vector. The pre-freeze price reference prevents an attacker from using freeze/unfreeze to bypass banding. The unfreeze_pending flag is consumed exactly once.

**Current Defenses:**
- C-01 fix: pre-freeze price stored for post-unfreeze banding reference
- H-01 fix: price zeroed on unfreeze, preventing stale pre-freeze price usage
- unfreeze_pending consumed exactly once

**Defense Gaps:**
- Admin could collude with cranker to freeze, change banding to 0 via `update_oracle_config` (requires frozen oracle — M-02 fix), then unfreeze — but this is admin-level compromise, not an external attack
- The `update_oracle_config` requiring frozen oracle is a good defense but admin can still freeze → change config → unfreeze → post arbitrary price

**Recommendation:**
1. Add a timelock on `update_oracle_config` changes — config changes require N-hour delay before taking effect
2. Log/emit events for all config changes for off-chain monitoring

---

### [ATK-04] Stale Oracle Exploitation Window

**Category:** Oracle  
**Severity:** Medium  
**Feasibility:** Practical (requires timing, no key compromise)  
**Max Extractable Value:** Bounded by warmup + price movement within staleness window

**Attack Flow:**
1. Attacker monitors oracle update frequency. Default `max_staleness_seconds` ranges from 5-300.
2. During a period of high off-chain price volatility, the on-chain oracle price becomes stale *but still within the staleness window*
3. Example: real SOL price drops 5% in 10 seconds. Oracle last updated 8 seconds ago (still valid with 15s staleness). Attacker opens long at the stale (higher) price.
4. Oracle updates to new (lower) price. Attacker is now underwater — but wait, this isn't profitable for the attacker.
5. Reverse: real price pumps 5%, oracle is stale at lower price. Attacker opens long at stale low price. Oracle catches up. Attacker has instant unrealized PnL.
6. Warmup locks this PnL as reserved. Attacker must wait ~400 seconds to extract.

**Current Defenses:**
- `max_staleness_seconds` configurable (min 5s)
- Warmup period (1000 slots ≈ 400s) locks new PnL
- 1-slot holding period prevents same-slot close
- During warmup, haircut reduces effective PnL

**Defense Gaps:**
- For a 15-second staleness window on a volatile memecoin, price can move 10-20% — this is within normal volatility, not manipulation
- Warmup is the only defense; if warmup period is set low, extraction is faster
- The attacker doesn't need to compromise anything — just monitor oracle freshness and trade at the right moment

**Recommendation:**
1. Reduce default `max_staleness_seconds` for volatile assets (5s for memecoins, 15s for majors)
2. Consider checking oracle confidence band before allowing new position opens — if confidence is wide, reduce max leverage
3. Enforce `MIN_WARMUP_PERIOD_SLOTS >= 100` (already done, good)

---

### [ATK-05] Fallback Oracle Injection

**Category:** Oracle  
**Severity:** Low  
**Feasibility:** Unlikely  
**Max Extractable Value:** N/A

**Attack Flow:**
1. Attacker tries to pass a fake oracle account as the fallback during a trade
2. `read_oracle_price_with_fallback` checks `fallback_account.key == expected_fallback_address` where expected comes from the on-chain `Market` account
3. Attack fails — can't spoof a different account

**Current Defenses:**
- Fallback address validated against `market.fallback_oracle_address` (stored on-chain)
- `admin_set_fallback_oracle` validates token_mint match for PerkOracle fallbacks
- Only admin can set fallback oracle configuration

**Defense Gaps:** None identified. This is well-defended.

**Recommendation:** No changes needed. The defense is sound.

---

### [ATK-06] Flash Loan + Oracle Delay Arbitrage

**Category:** Economic  
**Severity:** Medium  
**Feasibility:** Theoretical (Solana flash loans are limited)  
**Max Extractable Value:** Bounded by warmup + 1-slot holding period

**Attack Flow:**
1. Attacker observes pending oracle update in validator mempool (see ATK-14)
2. In the same block before the oracle update: flash-borrow collateral → deposit → open position
3. Oracle updates in next transaction within same slot
4. Attacker can't close in same slot (1-slot holding period)
5. Next slot: close position, withdraw, repay flash loan

**Analysis:** Solana doesn't have native flash loans like Ethereum (no atomic borrow-use-repay in single tx). Cross-program invocations could theoretically create flash-loan-like patterns, but the 1-slot holding period + warmup make this unprofitable in practice.

**Current Defenses:**
- 1-slot holding period (`MinHoldingPeriodNotMet`)
- Warmup period locks new PnL as reserved
- PerkOracle updates are independent of user transactions (not DEX pool reads)

**Defense Gaps:**
- If Solana develops atomic flash loan protocols, the 1-slot delay is the only barrier
- For Pyth oracle markets, Pyth updates can be bundled by validators with user transactions

**Recommendation:**
1. The 1-slot holding period is a good defense. Consider increasing to 2-3 slots for additional safety margin.
2. Monitor Solana flash loan protocol developments

---

### [ATK-07] Funding Rate Manipulation

**Category:** Economic  
**Severity:** Medium  
**Feasibility:** Practical (requires capital, not key compromise)  
**Max Extractable Value:** Bounded by funding_rate_cap_bps (10 bps = 0.1% per period)

**Attack Flow:**
1. Attacker opens a large position to skew vAMM mark price away from oracle
2. TWAP accumulator samples the skewed mark price (weighted by volume)
3. At funding crank time, TWAP mark diverges from oracle → funding rate is set
4. Attacker holds opposing position on another account → collects funding payments
5. The attacker pays funding on the "manipulation account" but earns it on the "collection account"

**Subtlety:** The volume-weighted TWAP (M2 R4 fix) means the attacker's large trade heavily influences the TWAP. If attacker does a massive trade just before funding crank, the TWAP is dominated by their skewed mark price.

**Current Defenses:**
- `funding_rate_cap_bps = 10` (0.1% per period) — caps max extraction per period
- Volume-weighted TWAP smoothing
- Both sides must have OI for funding to accrue
- TWAP resets each funding period

**Defense Gaps:**
- 0.1% per hour, compounded over 24h ≈ 2.4% — meaningful for large positions
- The attacker's volume dominates the TWAP if they're the largest trader in the period
- No check that TWAP samples come from diverse traders (single-trader TWAP manipulation)
- The attacker can time their massive trade right before `crank_funding` is called

**Recommendation:**
1. **Time-weight the TWAP** in addition to volume-weighting — sample at regular intervals (e.g., every 100 slots) to prevent last-second manipulation
2. Cap any single trade's contribution to the TWAP accumulator (e.g., max 10% of the period's total weight)
3. Consider using oracle price as the primary funding reference, with mark-oracle premium as a secondary signal

---

### [ATK-08] Oracle-Driven Liquidation Cascade

**Category:** Economic  
**Severity:** High  
**Feasibility:** Practical (requires cranker compromise on unbanded market)  
**Max Extractable Value:** Sum of all opposing positions' collateral

**Attack Flow:**
1. Attacker compromises cranker key for an unbanded memecoin market
2. Attacker opens a large short position at current price
3. Attacker posts a 90% lower oracle price
4. All long positions instantly fall below maintenance margin
5. Attacker (or accomplice) calls `liquidate` on every long position — permissionless
6. Each liquidation: deficit is socialized via `enqueue_adl`, which decreases the long side's A coefficient. The attacker's short position gains via K-diff settlement.
7. Liquidator rewards (50% of liquidation fee) go to the attacker's liquidator account
8. Insurance fund absorbs some deficit but is capped at 50%/epoch

**Critical insight:** The attacker doesn't need to close their own position to profit. They profit from:
- Direct liquidator rewards (50% of liq fees)
- K-coefficient gains from deficit socialization hitting the opposing side
- The cascading effect: each liquidation pushes more deficit into the system

**Current Defenses:**
- Insurance fund with epoch cap
- Haircut reduces profitable withdrawals when vault is stressed
- Conservation invariant check
- ADL eventually zeroes out positions

**Defense Gaps:**
- On unbanded markets, there's no speed limit on price manipulation
- Liquidations are permissionless — attacker can liquidate all vulnerable positions in a single block
- The attacker's own short position gains from the manipulated price AND from ADL deficit socialization
- No "pre-liquidation verification" against oracle health/freshness beyond staleness check

**Recommendation:**
1. **Implement the on-chain circuit breaker** (see ATK-01) — this is the single most impactful fix
2. For liquidations, consider requiring oracle confidence < X% and oracle age < Y (stricter than normal trade staleness)
3. Rate-limit liquidations per block per market (e.g., max 5 liquidations per slot)

---

### [ATK-09] Insurance Fund Drain via Repeated Liquidations

**Category:** Economic  
**Severity:** Medium  
**Feasibility:** Practical (requires cranker compromise)  
**Max Extractable Value:** 50% of insurance fund per 24-hour epoch

**Attack Flow:**
1. Create many small positions on one side (longs)
2. Manipulate oracle price to push them all underwater
3. Each liquidation generates deficit → `use_insurance_buffer` drains insurance
4. After 24h epoch resets, repeat

**Current Defenses:**
- `INSURANCE_EPOCH_CAP_BPS = 5000` (50% per 24h)
- Insurance epoch on independent 24h timer (H3 fix — not tied to funding period)
- `insurance_floor` prevents total drainage

**Defense Gaps:**
- 50%/day is still aggressive — fund is halved every day under sustained attack
- Over 3 days: fund drops to 12.5% of original
- The insurance_floor provides a hard stop but may be set too low

**Recommendation:**
1. Reduce `INSURANCE_EPOCH_CAP_BPS` to 2000-3000 (20-30%) for better survivability
2. Make insurance floor dynamic — e.g., floor = max(configured_floor, 20% of vault TVL)
3. Implement anomaly detection: if insurance payouts exceed X% in Y hours, auto-pause market

---

### [ATK-10] ADL Gaming — Targeted Victim Selection

**Category:** Economic  
**Severity:** Low  
**Feasibility:** Unlikely  
**Max Extractable Value:** N/A (ADL is proportional)

**Attack Flow:**
1. Attacker tries to trigger ADL against specific counterparties
2. ADL works through A-coefficient reduction — affects ALL positions on the opposing side proportionally
3. Attacker cannot target a specific victim

**Analysis:** The Percolator ADL mechanism is proportional by design. The A coefficient affects all positions on a side equally (as a ratio of their a_snapshot). There's no way to selectively ADL one position without affecting all others.

**Current Defenses:**
- ADL is proportional (A/K coefficient system)
- Epoch-based tracking prevents double-counting

**Defense Gaps:** None for targeted selection. However, an attacker CAN trigger ADL against an entire side, which harms all participants on that side proportionally.

**Recommendation:** No changes needed for targeting. The proportional ADL design is sound.

---

### [ATK-11] Vault Drain via Manufactured Bad Debt

**Category:** Insolvency  
**Severity:** High  
**Feasibility:** Practical (requires cranker compromise on unbanded market)  
**Max Extractable Value:** Up to vault balance minus (C_tot + insurance_floor + claimable_fees)

**Attack Flow:**
1. Attacker opens a leveraged long on an unbanded memecoin market
2. Separate attacker account opens an equally sized short
3. Cranker posts a massively inflated price
4. Long position has huge positive PnL → but locked in warmup (reserved_pnl)
5. Short position has huge negative PnL → equity goes deeply negative → deficit
6. Attacker (or anyone) liquidates the short → deficit flows to `enqueue_adl`
7. Insurance absorbs up to 50%/epoch of the deficit
8. Remaining deficit: K-coefficient haircut on the long side (but there's only one long — the attacker)
9. The attacker's long position suffers the haircut, but still has massive unrealized PnL
10. After warmup, the "released" PnL is haircutted by `haircut_ratio` — which depends on vault residual

**Key insight:** The conservation check `V >= C_tot + I + claimable_fees` should prevent over-extraction. When vault balance decreases from liquidation reward transfers, the haircut ratio tightens. The attacker can only extract the vault residual (V - C_tot - I - fees), which is bounded by the profits available in the system.

**However:** If the attacker IS both the long and short, the short's collateral loss flows into the deficit, which is absorbed by insurance + haircut. The long's profit is haircutted. The net extraction is limited to insurance fund drainage + any vault residual.

**Current Defenses:**
- Conservation invariant check on close/liquidate/withdraw
- Haircut ratio: limits profit extraction to available vault residual
- Warmup delays profit realization
- Insurance epoch cap
- `MAX_ACCOUNT_POSITIVE_PNL` bounds per-account profit

**Defense Gaps:**
- The insurance fund IS extractable (up to 50%/epoch)
- Self-trading (long + short same entity, different accounts) enables controlled deficit creation
- No check prevents the same entity from holding both sides

**Recommendation:**
1. Consider a "net position" view — if two accounts from similar funding sources hold opposing positions, flag for review
2. Strengthen conservation check to include unrealized PnL obligations
3. On markets with < $X TVL, reduce max leverage to limit deficit creation

---

### [ATK-12] Warmup Bypass via Partial Close

**Category:** Insolvency  
**Severity:** Low  
**Feasibility:** Unlikely (mitigated by M10 fix)  
**Max Extractable Value:** N/A (fixed)

**Attack Flow:**
1. Open position, gain PnL
2. Partially close to trigger profit conversion
3. Withdraw the converted principal

**Analysis:** The M10 fix explicitly calls `do_profit_conversion` on partial closes when `released_pos > 0`. The warmup slope and reservation system ensure that only matured profits are converted. The haircut ratio further limits extraction.

**Current Defenses:**
- M10 fix: partial close calls `do_profit_conversion`
- Warmup slope controls release rate
- Haircut limits extraction to vault residual

**Defense Gaps:** None identified. This is well-patched.

**Recommendation:** No changes needed. Verify warmup slope calculation edge cases in unit tests.

---

### [ATK-13] Dust Position Griefing

**Category:** Insolvency  
**Severity:** Low  
**Feasibility:** Practical (requires capital for minimum deposits)  
**Max Extractable Value:** Negligible direct value; DoS potential

**Attack Flow:**
1. Create thousands of accounts with `MIN_DEPOSIT_AMOUNT` (1000 tokens) each
2. Open minimum-size positions across many markets
3. These positions are too small to be worth liquidating (gas cost > reward)
4. They accumulate funding debt, phantom dust, and clog the system

**Current Defenses:**
- `MIN_DEPOSIT_AMOUNT = 1_000`
- `MIN_REMAINING_POSITION_SIZE = 100`
- Phantom dust clearance mechanism
- `reclaim_empty_account` permissionless cleanup
- `MIN_NONZERO_MM_REQ = 10_000` ensures even tiny positions have meaningful margin requirements

**Defense Gaps:**
- Account creation cost on Solana is ~0.002 SOL (rent) — cheap for mass creation
- Liquidation reward may not cover Solana transaction fees for very small positions
- Could clog `stored_pos_count` and slow down ADL/reset transitions

**Recommendation:**
1. Increase `MIN_DEPOSIT_AMOUNT` to 10_000-100_000 depending on the collateral token
2. Consider a minimum notional size for position opens (e.g., $10 worth)
3. Ensure `reclaim_empty_account` remains gas-efficient for cleanup

---

### [ATK-14] Oracle Update Frontrunning (Validator MEV)

**Category:** MEV  
**Severity:** High  
**Feasibility:** Practical (requires validator access or Jito bundle construction)  
**Max Extractable Value:** Per-trade: bounded by price delta * position size * (1 - fees). Realistic: 0.1-2% per oracle update for active markets.

**Attack Flow:**
1. Validator (or Jito bundle submitter) observes a `update_perk_oracle` transaction in the mempool
2. The new price is visible in the transaction data (params.price is plaintext)
3. Before the oracle update: open position in the direction of the upcoming price change
4. After the oracle update: K-diff settlement applies the price change to the new position
5. Wait 1 slot (holding period), then close position and extract profit
6. Warmup reserves the PnL — but the position was only open for 2 slots, so very little time for warmup to release anything

**Key nuance:** The warmup defense is STRONG here. Even though the attacker can frontrun the oracle update, the PnL from the 1-slot position goes into `reserved_pnl`. With `warmup_slope = reserved_pnl / warmup_period_slots`, and `warmup_period_slots = 1000`, only 0.1% of the profit is released per slot. After 2 slots, the attacker can extract ~0.2% of the profit.

**But:** If the attacker doesn't close and instead waits for warmup to release over 1000 slots (~400 seconds), they can extract the full haircutted profit. The opportunity cost is capital lockup, but for a risk-free trade, it's worth it.

**Current Defenses:**
- 1-slot holding period
- Warmup reserves new PnL (~400 seconds to fully release)
- Haircut reduces profit when vault is stressed
- Trading fees (0.03%+ per trade) eat into small-delta profits

**Defense Gaps:**
- Oracle update data is plaintext in the transaction — validators see it before execution
- On Solana with Jito, bundle ordering is purchasable
- For large price moves (>1% oracle delta), the warmup-delayed profit can exceed fees
- The attacker bears no real risk — the price move is known before they commit

**Recommendation:**
1. **Encrypt oracle update data** — use a commit-reveal scheme where the cranker first commits a hash, then reveals the price in the next slot. This prevents frontrunning.
2. As a simpler alternative: **batch oracle updates with position operations** — the cranker could submit oracle update + a market-making trade in the same transaction, reducing the arbitrage window.
3. Consider using Solana's `durable nonces` or Jito tip mechanisms to make oracle updates higher priority than user transactions.

---

### [ATK-15] Liquidation MEV — Timing and Ordering

**Category:** MEV  
**Severity:** Medium  
**Feasibility:** Practical (anyone can compete)  
**Max Extractable Value:** Liquidator reward (50% of liquidation fee on position notional)

**Attack Flow:**
1. Validator observes an oracle update that will push positions below maintenance margin
2. Validator constructs a bundle: [oracle_update, liquidate_position_A, liquidate_position_B, ...]
3. Validator earns all liquidation rewards by ordering their liquidation transactions first
4. Other liquidators are crowded out

**Analysis:** This is standard MEV, not unique to Perk. The 50/50 split (liquidator/insurance) is reasonable. Solana's block production model (single leader per slot) inherently concentrates MEV power.

**Current Defenses:**
- Liquidation is permissionless (competitive)
- 50/50 reward split reduces liquidator profit
- Liquidator reward capped to available collateral (H2 R3 fix)

**Defense Gaps:**
- Validator has absolute ordering power within their slot
- No Dutch auction or priority gas mechanism for liquidation ordering
- On Jito-enabled validators, liquidation MEV is explicitly auctioned

**Recommendation:**
1. Consider a **Dutch auction liquidation model** — liquidation reward starts low and increases over time, incentivizing faster liquidation while reducing MEV extraction
2. Alternatively: randomized liquidation reward within a range (e.g., 40-60% of liq fee) to make MEV extraction less predictable
3. This is a market-level concern, not protocol-breaking — deprioritize vs ATK-01/02/08

---

## Protocol Insolvency Analysis

### Can the vault become insolvent?

**Short answer:** Yes, under specific conditions — but the protocol has multiple layers preventing it.

**Insolvency conditions (all must hold simultaneously):**

1. **Oracle manipulation on unbanded market** — cranker posts a price vastly divergent from reality
2. **Large opposing positions exist** — significant OI on the "losing" side
3. **Insurance fund is depleted** — from prior deficit events or epoch cap reached
4. **Haircut is insufficient** — vault residual doesn't cover remaining PnL obligations

**The insolvency cascade:**
```
Manipulated price → Massive deficits on one side → Insurance absorbs up to cap
→ Remaining deficit → K-coefficient haircut on opposing side
→ If haircut insufficient → vault_balance < C_tot + I + claimable_fees
→ Conservation check FAILS → Transaction reverts
```

**Key protection:** The conservation check (`V >= C_tot + I + claimable_fees`) prevents any transaction from completing if it would cause insolvency. This means the protocol will **halt operations** (all transactions revert) rather than allow insolvency. This is the correct behavior — "halt > insolvency."

**Residual risk:** If the conservation check passes but the on-chain state is corrupted (e.g., `vault_balance` tracking diverges from actual SPL token balance), the protocol could become silently insolvent. This would require a bug in the `vault_balance` bookkeeping, not an external attack.

**Conditions under which the vault CAN'T become insolvent:**
- Normal operations (no oracle compromise)
- Banded markets with reasonable banding (attacker rate-limited)
- Warmup period active and > 0
- Conservation check enforced on all exit paths (close, withdraw, liquidate)

### Theoretical maximum loss per market:
- Insurance fund balance × 50% (epoch cap)
- Plus: vault residual (V - C_tot - I - fees)
- Capped at: total vault balance
- Protected by: haircut reducing profitable withdrawals pro-rata

---

## Additional Findings (Not in Original Scope)

### [ATK-16] Admin Key as Single Point of Failure

**Category:** Governance  
**Severity:** Critical (if compromised)  
**Feasibility:** Requires physical Ledger compromise or social engineering

**Analysis:** Admin can: pause protocol, freeze oracles, change oracle config, set fallback oracles, update market parameters, transfer admin. A compromised admin can:
- Disable banding on all oracles (freeze → update_config → unfreeze)
- Set fallback to a malicious oracle
- Pause protocol to prevent user withdrawals during an attack

**Recommendation:** Implement a governance timelock for critical admin operations (config changes, admin transfer). Immediate-effect operations should be limited to emergency pause/freeze.

### [ATK-17] TWAP Accumulator Overflow

**Category:** Technical  
**Severity:** Low  
**Feasibility:** Unlikely (requires extreme volume)

**Analysis:** `mark_price_accumulator` (u128) = mark_price (u64) × trade_notional (u128). Uses `saturating_add` and `saturating_mul`, so overflow saturates rather than panics. But saturated values would corrupt the TWAP, leading to incorrect funding rates.

Max single-trade contribution: ~u64::MAX × u128::MAX → saturates. This is extremely unlikely in practice.

**Recommendation:** The saturating math is acceptable given the normative bounds on trade sizes and prices.

---

## Risk Summary Matrix

| ID | Attack | Severity | Feasibility | Defended? | Priority Fix |
|------|--------|----------|-------------|-----------|-------------|
| ATK-01 | Cranker key compromise (unbanded) | **Critical** | Practical | Partial (warmup, insurance) | 🔴 On-chain circuit breaker |
| ATK-02 | Price banding slow walk | **High** | Practical | Partial (per-update only) | 🔴 Sliding window band |
| ATK-03 | Freeze/unfreeze cycle | Low | Unlikely | ✅ Yes (C-01 fix) | — |
| ATK-04 | Stale oracle window | Medium | Practical | Partial (warmup) | 🟡 Tighter staleness |
| ATK-05 | Fallback oracle injection | Low | Unlikely | ✅ Yes | — |
| ATK-06 | Flash loan + oracle delay | Medium | Theoretical | ✅ Yes (warmup + hold) | — |
| ATK-07 | Funding rate manipulation | Medium | Practical | Partial (cap, TWAP) | 🟡 Time-weighted TWAP |
| ATK-08 | Liquidation cascade | **High** | Practical | Partial (insurance cap) | 🔴 Circuit breaker |
| ATK-09 | Insurance fund drain | Medium | Practical | Partial (epoch cap) | 🟡 Lower cap, dynamic floor |
| ATK-10 | ADL targeting | Low | Unlikely | ✅ Yes (proportional) | — |
| ATK-11 | Bad debt vault drain | **High** | Practical | Partial (conservation) | 🟡 Net position monitoring |
| ATK-12 | Warmup bypass | Low | Unlikely | ✅ Yes (M10 fix) | — |
| ATK-13 | Dust position griefing | Low | Practical | Partial (minimums) | 🟢 Higher minimums |
| ATK-14 | Oracle frontrunning (MEV) | **High** | Practical | Partial (warmup) | 🔴 Commit-reveal oracle |
| ATK-15 | Liquidation MEV | Medium | Practical | Partial (competitive) | 🟡 Dutch auction liq |
| ATK-16 | Admin key compromise | Critical | Requires physical | Partial (Ledger) | 🟡 Governance timelock |
| ATK-17 | TWAP overflow | Low | Unlikely | ✅ Yes (saturating) | — |

---

## Top 3 Recommendations (Prioritized)

### 1. 🔴 On-Chain Circuit Breaker (Addresses ATK-01, ATK-02, ATK-08)
Implement automatic market pause when oracle price deviates > X% from EMA within Y slots. No admin action required. This single change dramatically reduces the damage window for cranker compromise from "until admin responds" to "until circuit breaker triggers" (1-3 slots).

### 2. 🔴 Commit-Reveal Oracle Updates (Addresses ATK-14)
Encrypt oracle price data using a commit-reveal scheme. Cranker commits hash in slot N, reveals price in slot N+1. Validators cannot frontrun what they can't read. Alternative: use encrypted memos or threshold decryption.

### 3. 🟡 Sliding Window Price Banding (Addresses ATK-02)
Replace per-update banding with a sliding window: track oracle price over the last N slots, reject any update that deviates > X% from the window's min/max. This prevents the slow-walk attack while still allowing legitimate volatility.

---

*Report generated by Apex Red Team automated analysis. All findings should be validated against the latest codebase and tested with proof-of-concept exploits before remediation.*
