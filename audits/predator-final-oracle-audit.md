# 🔴 Predator Final Audit — PerkOracle System

**Auditor:** Predator (adversarial pass)
**Date:** 2026-03-24
**Scope:** PerkOracle on-chain + off-chain cranker, oracle engine, all consuming instructions
**Prior audit:** Yes — this is the re-audit after fixes were applied.

---

## Executive Summary

The PerkOracle system is **significantly hardened** since the first pass. The major vectors (cross-token oracle injection, gap attacks, unbounded price jumps after unfreeze) are properly mitigated. However, I found **3 medium-severity issues**, **4 low-severity issues**, and **2 informational notes** that are worth attention. None of these are immediate "steal all the money" bugs, but several could cause economic damage under specific conditions.

**Severity scale:** Critical (steal funds) | High (protocol insolvency) | Medium (economic damage / griefing with cost) | Low (minor edge case / defense-in-depth gap) | Info (design observation)

---

## Findings

---

### M-01: EMA Manipulation via Saturating Math — Gradual Ratchet to MAX_ORACLE_PRICE

**Severity:** Medium
**File:** `update_perk_oracle.rs` L65-72

**The code:**
```rust
oracle.ema_price = params.price
    .saturating_add(oracle.ema_price.saturating_mul(9))
    / 10;
```

**Attack:**
1. EMA uses `saturating_mul(9)` — if `ema_price` is already high, `ema_price * 9` saturates to `u64::MAX`.
2. Then `u64::MAX.saturating_add(price)` still = `u64::MAX`.
3. `u64::MAX / 10 = 1_844_674_407_370_955_161` — a massive number.
4. Next update: `price + 1_844_674_407_370_955_161 * 9` → saturates again → `u64::MAX / 10` again.
5. The EMA is now pinned at ~1.84e18 and can never decrease meaningfully.

**Feasibility:** Low-Medium. The `price` field is bounded by `MAX_ORACLE_PRICE` (1e12), but the EMA has no such bound. A compromised cranker (or a bug causing `ema_price` to spike once) permanently corrupts the EMA.

**Impact:** Currently **low** because the EMA is explicitly documented as "non-critical (not consumed by any instruction)." But if any future instruction ever reads `ema_price` for risk calculation, this becomes critical. The code comment says it's non-critical, but the field is publicly readable and could be consumed by off-chain bots for position decisions.

**What stops it:** The EMA isn't used in any on-chain path today.

**Recommendation:** Add a normative bound: `oracle.ema_price = core::cmp::min(ema_result, MAX_ORACLE_PRICE)`. This is zero-cost and future-proofs the field.

---

### M-02: Price Banding Bypass via `update_oracle_config` on Live Oracle

**Severity:** Medium
**File:** `update_oracle_config.rs`

**Attack:**
1. Oracle has `max_price_change_bps = 3000` (30% band) and current price is $100.
2. Admin calls `update_oracle_config` with `max_price_change_bps = 0` (disables banding).
3. Cranker posts price = $1 (or $10,000) — no banding check.
4. Admin calls `update_oracle_config` with `max_price_change_bps = 3000` again.

**The config update does NOT require the oracle to be frozen.** This means banding can be silently disabled and re-enabled in the same block with no observable on-chain evidence except the config change transactions.

**Feasibility:** Requires admin key compromise. But the attack leaves minimal trace and bypasses the entire banding safety net.

**Impact:** Combined with a compromised cranker, this enables instant arbitrary price manipulation that the banding was specifically designed to prevent.

**What stops it:** Admin key security. The `update_oracle_config` is admin-only.

**Recommendation:** Either (a) require oracle to be frozen before config changes (aligns with the "freeze before maintenance" pattern), or (b) force a fresh price update after config change by zeroing the price (same as unfreeze does). Option (a) is cleaner.

---

### M-03: Fallback Oracle Source Mismatch — Pyth vs PerkOracle Price Semantics

**Severity:** Medium
**File:** `oracle.rs` L145-175 (`read_oracle_price_with_fallback`), `admin_set_fallback_oracle.rs`

**Attack scenario:**
1. Market has primary = PerkOracle (token X), fallback = Pyth (token X price feed).
2. PerkOracle goes stale → fallback activates.
3. Pyth price for token X uses a different base denomination, confidence model, or scaling — it's validated by the Pyth SDK, not by PerkOracle's semantics.
4. The confidence validation uses the same `ORACLE_CONFIDENCE_BPS` (2%) for both sources, but Pyth's confidence semantics are statistical (±1σ) while PerkOracle's confidence is max-min spread across sources. These are different distributions.

**More critically:** When switching from primary to fallback mid-position, the price could jump significantly. A user who opened at PerkOracle price $100 might get closed at Pyth price $102 (or $98) — the fallback price is not banded against the primary's last known price.

**Feasibility:** Moderate. Requires the primary oracle to fail, which is a real operational scenario.

**Impact:** Users can be liquidated (or avoid liquidation) based on a price jump during oracle failover. A sophisticated attacker could:
1. Know that the PerkOracle is about to go stale (cranker downtime).
2. Open a leveraged position in the direction they expect the Pyth fallback to differ.
3. Profit from the price discontinuity when fallback activates.

**What stops it:** The `admin_set_fallback_oracle` validates the fallback is a real oracle for the same token. But it doesn't enforce price parity between primary and fallback at activation time.

**Recommendation:** When fallback activates, apply a cross-oracle banding check: reject if `|primary_last_price - fallback_price| > X%`. The primary's last known price is stored in `market.last_oracle_price`. Add:
```rust
if market.last_oracle_price > 0 {
    let diff = abs_diff(fallback_price, market.last_oracle_price);
    let max_diff = market.last_oracle_price * FALLBACK_MAX_DEVIATION_BPS / 10000;
    require!(diff <= max_diff, PerkError::OracleFallbackDeviation);
}
```

---

### L-01: `_reserved` Byte Coupling — Semantic Collision Risk

**Severity:** Low
**File:** `perk_oracle.rs`, `update_perk_oracle.rs`, `freeze_perk_oracle.rs`, `initialize_perk_oracle.rs`

**Layout:**
- `_reserved[0]`: unfreeze_pending flag (0/1)
- `_reserved[1..3]`: max_price_change_bps (u16 LE)
- `_reserved[3..11]`: pre-freeze price (u64 LE)
- `_reserved[11..64]`: truly unused

**Risk:** The `_reserved` field was designed as a future-proofing buffer but now carries 3 distinct semantic fields packed into raw bytes. If a future developer adds a new field at `_reserved[2]` or `_reserved[3]`, they silently corrupt the banding config or pre-freeze price.

**What stops it:** Code comments document the layout, and the three code paths that touch `_reserved` are clearly annotated.

**Recommendation:** Before v2, migrate these to named fields with a proper account migration. For now, add a compile-time assert or module-level doc block that catalogs the entire `_reserved` layout in one place.

---

### L-02: Cranker Key Compromise — Bounded but Significant Damage Window

**Severity:** Low (with current banding) / High (if banding is 0)
**Files:** `update_perk_oracle.rs`, `oracle-cranker.ts`

**Attack: Compromised cranker key (NOT admin):**
1. Cranker can post any price within the band limit per slot.
2. With `max_price_change_bps = 3000` (30%), attacker can move price 30% per slot (~400ms).
3. Over 10 slots (4 seconds), price can move: `1.3^10 ≈ 13.8x` — from $100 to $1,379.
4. That's enough to liquidate every position on the opposite side.

**Step-by-step:**
1. Attacker compromises cranker private key.
2. Rapidly posts price at +30% each slot for 10 consecutive slots.
3. All short positions get liquidated (maintenance margin is 5%, price moved 1,280%).
4. Attacker has their own long position ready → profits from the liquidation cascade.

**Mitigation already present:**
- Rate limit: 1 update per slot ✅
- Price banding: constrains per-update movement ✅
- `MIN_PRICE_CHANGE_BPS = 100` (1%): bands can't be set tighter than 1% ✅

**What stops total destruction:** Banding. A 1% band means 10 slots only produces `1.01^10 ≈ 1.105x` (10.5% total) — within maintenance margin for low-leverage positions.

**Residual risk:** Markets with `max_price_change_bps = 0` (memecoins) have **no banding at all**. A compromised cranker can post any price instantly and drain the market.

**Recommendation:** For `max_price_change_bps = 0` markets, consider adding a universal fallback band (e.g., 50% max jump per update) that applies even when per-market banding is disabled. This limits damage from key compromise without restricting legitimate memecoin volatility much.

---

### L-03: `admin_update_market` Can Change `oracle_address` Without Changing `oracle_source`

**Severity:** Low
**File:** `admin_update_market.rs`

**Issue:** The admin can update `oracle_address` but the instruction validates using the *existing* `market.oracle_source`. If the admin wants to switch from Pyth to PerkOracle (or vice versa), they can't — the oracle_source is not updatable.

But: admin can set `oracle_address` to a PerkOracle account while `oracle_source` is still `Pyth`. The `validate_oracle` call would fail (owner check — PerkOracle is owned by the Perk program, not Pyth receiver). So this is blocked.

The reverse is also blocked: setting a Pyth address when source is PerkOracle would fail the owner check.

**Verdict:** Not exploitable — the cross-validation is correct. But the inability to change `oracle_source` means migrating a market from Pyth to PerkOracle requires deploying a new market entirely. This is a design limitation, not a vulnerability.

---

### L-04: Jito Fallback Leaks Oracle Updates to Public Mempool

**Severity:** Low
**File:** `oracle-cranker.ts` L297-310

**The code:**
```typescript
if (this.config.jito!.jitoOnly) {
    // jitoOnly mode: do NOT leak to public mempool — skip this update
    continue;
}
// Fallback to normal RPC if Jito fails
sig = await this.client.updatePerkOracle(mint, { ... });
```

**Attack:**
1. Cranker is configured with Jito but `jitoOnly = false` (the default).
2. Jito is temporarily unavailable (or attacker DoS's the Jito block engine).
3. Oracle update falls back to normal RPC → transaction visible in public mempool.
4. MEV searcher front-runs the oracle update:
   - Sees pending price change (e.g., SOL going from $100 → $105).
   - Opens a long position before the oracle update lands.
   - Oracle update lands → position is immediately profitable.

**Feasibility:** Real, especially on Solana where validators can reorder transactions. The mempool visibility window is short but sufficient for co-located searchers.

**What stops it:** `jitoOnly = true` prevents this entirely. But it's **not the default**, and operators may not understand the security implication of the fallback.

**Recommendation:** Change default to `jitoOnly = true` for production deployments, or at minimum add prominent documentation that `jitoOnly = false` creates a front-running window.

---

### INFO-01: PDA-Seeded Oracle Prevents Rogue Oracle Injection

**Severity:** Informational (positive finding)

**Attack attempted:** Can I create my own PerkOracle, become its authority, and get it used by a market?

**Analysis:**
- PerkOracle PDA: `seeds = [b"perk_oracle", token_mint.key().as_ref()]`
- Only one PerkOracle can exist per token mint (PDA is deterministic).
- `initialize_perk_oracle` requires `protocol.admin` as signer.
- `create_market` validates `oracle_account.owner == crate::ID` + PDA derivation.
- `has_one = authority` on updates binds to the authority set at init.

**Verdict:** Completely blocked. An attacker cannot:
1. Create their own PerkOracle (needs admin signer).
2. Pass a fake oracle to create_market (PDA + owner check).
3. Update an existing oracle (needs authority key).

✅ This is well-designed.

---

### INFO-02: Gap Attack After Prolonged Staleness — Properly Mitigated

**Severity:** Informational (positive finding)

**Attack attempted:** Oracle goes stale for days → cranker posts wildly different price → profit from stale-to-fresh price jump.

**Analysis:**
1. If `gap > 2 * max_staleness_seconds`, `update_perk_oracle` rejects with `OracleGapTooLarge`.
2. Admin must freeze → unfreeze to allow updates again.
3. On unfreeze: `price = 0`, `ema_price = 0`, `_reserved[0] = 1` (unfreeze_pending flag).
4. First update after unfreeze: bypasses gap check (flag = 1) but IS banded against pre-freeze price stored in `_reserved[3..11]`.
5. `read_perk_oracle_price` rejects `price == 0`, so no instruction can use the oracle between unfreeze and first update.

**Verdict:** Properly mitigated. The pre-freeze price banding (C-01 fix) closes the window. The only way to bypass this is to also disable banding via `update_oracle_config`, which requires admin key — see M-02 above.

✅ Solid fix chain.

---

## Attack Scenario Deep-Dives

### Scenario 1: Rogue Oracle Creation
**Result:** ❌ Not possible. PDA seeds + admin-only init. See INFO-01.

### Scenario 2: Reserved Byte Layout Exploitation
**Result:** ⚠️ Low risk. All write paths are in 3 instructions (init, update, freeze/unfreeze). No external code path touches `_reserved`. See L-01 for future risk.

### Scenario 3: Freeze-to-Update Gap Exploitation
**Result:** ❌ Properly mitigated. See INFO-02.

### Scenario 4: EMA Saturation Manipulation
**Result:** ⚠️ EMA can be permanently corrupted but isn't consumed on-chain. See M-01.

### Scenario 5: Jito Fallback Front-Running
**Result:** ⚠️ Real with default config. See L-04.

### Scenario 6: Fallback Oracle Price Discontinuity
**Result:** ⚠️ Price jump at failover is unbounded. See M-03.

### Scenario 7: Price Banding Walk Attack
**Attack:** Post prices at exactly +band_limit every slot to walk price in one direction.
**Analysis:** With `max_price_change_bps = 3000`:
- Per slot: +30%
- 10 slots: 1.3^10 = 13.8x
- 25 slots (10 seconds): 1.3^25 = 705x

This is fast enough to cause massive liquidations. The rate limit (1/slot) is the only brake.

**However:** This requires the cranker key (authority). A non-authority signer cannot call `update_perk_oracle` (`has_one = authority` constraint). So it's a key compromise scenario only. See L-02.

**Additional consideration:** Could an attacker DoS the legitimate cranker (e.g., drain its SOL) to prevent corrective updates? Yes — if the cranker wallet runs out of SOL for transaction fees, it can't post corrections. This widens the damage window.

**Recommendation:** Cranker wallet should have SOL balance monitoring with alerts.

### Scenario 8: Config Update Without Freeze
**Result:** ⚠️ Banding can be silently disabled/re-enabled. See M-02.

### Scenario 9: Permanent DoS via State Manipulation
**Attack:** Can I brick the oracle so it can never be updated again?
**Analysis:**
- Set `is_frozen = true`? Only admin can freeze.
- Corrupt `_reserved` bytes? Only 3 code paths write them, all require authority or admin.
- Make `last_slot = u64::MAX`? `last_slot` is set to `clock.slot` on every update, and the slot only increases. Even if an update succeeds at a very high slot, the next real slot will be higher.
- Make `max_staleness_seconds = 0`? Bounded by `MIN_ORACLE_STALENESS_SECONDS = 5` at init. Config update only touches banding, not staleness.

**Verdict:** ❌ Cannot permanently DoS. Admin can always freeze/unfreeze to reset state.

### Scenario 10: Key Compromise Damage Assessment

**Cranker key only:**
| Market type | Banding | Max damage per second | Mitigation time |
|---|---|---|---|
| Deep liquidity (bps=3000) | 30%/slot | 705x price move in 10s | Admin freeze (~seconds if monitoring) |
| Memecoin (bps=0) | None | Instant arbitrary price | Admin freeze |

**Admin key only:**
- Can freeze all oracles (DoS all trading).
- Can change oracle config (disable banding — but can't post prices without cranker key).
- Can set fallback oracle to anything (but validated at set time).
- Can transfer oracle authority to attacker-controlled key → then has cranker power too.
- Can deactivate markets, change fees to max (1%), change leverage.

**Both keys compromised:**
- Full control. Arbitrary prices, no banding, no freeze protection.
- **Maximum damage:** Drain all positions on all markets. Total protocol TVL at risk.
- **Mitigation:** Time-locked admin operations would limit blast radius. Currently, admin ops are instant.

---

## Summary Table

| ID | Severity | Title | Exploitable? | Fix needed? |
|----|----------|-------|-------------|-------------|
| M-01 | Medium | EMA saturation via saturating math | Only with cranker key | Yes — add cap |
| M-02 | Medium | Config update without freeze bypasses banding | Only with admin key | Yes — require freeze |
| M-03 | Medium | Fallback oracle price discontinuity at failover | Operational scenario | Yes — add cross-oracle band |
| L-01 | Low | `_reserved` byte semantic coupling | Not directly | Migrate to named fields |
| L-02 | Low | Cranker key compromise + no banding = instant drain | Key compromise only | Add universal fallback band |
| L-03 | Low | Cannot change oracle_source after market creation | Design limitation | Accept or add migration path |
| L-04 | Low | Jito fallback leaks to mempool | Default config | Change default to jitoOnly |
| INFO-01 | Info | PDA prevents rogue oracle injection | ❌ Not possible | None needed ✅ |
| INFO-02 | Info | Gap attack properly mitigated | ❌ Not possible | None needed ✅ |

---

## Overall Assessment

**The oracle system is well-built.** The PDA-based oracle identity, authority separation, price banding, gap attack prevention, and fallback validation are all solid. The previous audit findings (H-01, C-01, M-02 confidence, M-04 authority recovery) are properly fixed.

**The remaining risks are almost entirely in the "key compromise" category.** If neither the cranker key nor the admin key is compromised, I couldn't find a way to steal money or break the protocol through the oracle system alone. The architecture is sound.

**The three medium findings are real but conditional:**
- M-01 (EMA) is latent — no impact today, but a ticking time bomb if EMA is ever used.
- M-02 (config without freeze) requires admin key but defeats the purpose of banding.
- M-03 (fallback price jump) is the most concerning for normal operation — it's a real scenario that doesn't require any key compromise.

**Priority fix order:** M-03 → M-02 → M-01 → L-04 → L-02 → L-01.

---

*Predator out. The protocol is solid — my job was to find anything left, and this is what I found. Ship it with the M-03 fix and you're in good shape.*
