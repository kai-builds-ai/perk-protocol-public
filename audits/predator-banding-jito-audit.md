# 🩸 Predator Audit: Price Banding + Jito Bundle Support

**Auditor:** Predator (adversarial smart contract auditor)  
**Date:** 2026-03-24  
**Scope:** On-chain price banding (`update_perk_oracle.rs`, `update_oracle_config.rs`, `freeze_perk_oracle.rs`, `initialize_perk_oracle.rs`, `constants.rs`) + off-chain Jito bundle submission (`oracle-cranker.ts`)  
**Methodology:** Attacker-first. Every finding answers "can I steal money or break things?"

---

## Executive Summary

The price banding implementation is **mechanically correct** — no overflows, no bypasses in the happy path. But the **design** has a critical gap: banding limits per-update change, not cumulative drift. A compromised cranker can compound 30% moves every slot (~400ms), reaching **23x price manipulation in 5 seconds**. The Jito integration has a **silent degradation** path where hardcoded tip accounts go stale, forcing persistent fallback to the public mempool — negating the entire purpose of private submission.

**Critical: 1 | High: 2 | Medium: 3 | Low: 2 | Informational: 2**

---

## Findings

### [C-01] CRITICAL — Unfreeze Zeroes Price → Banding Completely Bypassed on First Update

**File:** `update_perk_oracle.rs:52-60`, `freeze_perk_oracle.rs:30-37`

**The Attack:**
1. Admin unfreezes oracle → `oracle.price = 0`, `_reserved[0] = 1`
2. The banding check: `if max_change_bps > 0 && oracle.price > 0` — the **`oracle.price > 0`** clause is **false**
3. Banding is **completely skipped** on the first update after unfreeze
4. Cranker can post **any price** from 1 to `MAX_ORACLE_PRICE` (1e12) in one shot

**Why This Matters:**  
The entire point of banding is to limit damage from a compromised cranker. But a compromised cranker who can convince an admin to unfreeze (social engineering, or if admin triggers a routine unfreeze after a stale period) gets a **free shot** to post an arbitrarily wrong price. That single bad price feeds into all position valuations, liquidations, and PnL calculations.

**Exploit Scenario:**
- Oracle goes stale (network issues, source APIs down)
- Gap check triggers, oracle becomes unusable
- Admin unfreezes to restore service
- Compromised cranker immediately posts price 100x the real value
- Positions on one side get liquidated, attacker profits

**Severity:** CRITICAL — bypasses the exact security mechanism banding was designed to provide, at the exact moment the oracle is most vulnerable (recovery from a disruption).

**Fix:** After unfreeze, still enforce banding against the **EMA** price (which is also zeroed — that's a problem). Better: store the last known price in `_reserved[3..11]` before zeroing, and band the first update against it. Or: require the admin to provide an expected price range during unfreeze, and band the first cranker update against that range.

```rust
// Proposed: Unfreeze stores last_known_price for banding reference
if !frozen {
    let last_price_bytes = oracle.price.to_le_bytes();
    oracle._reserved[3..11].copy_from_slice(&last_price_bytes);
    oracle.price = 0;
    oracle.ema_price = 0;
    oracle._reserved[0] = 1;
}

// In update_perk_oracle: use stored price for banding after unfreeze
let band_reference_price = if oracle.price == 0 {
    u64::from_le_bytes(oracle._reserved[3..11].try_into().unwrap())
} else {
    oracle.price
};
if max_change_bps > 0 && band_reference_price > 0 { ... }
```

---

### [H-01] HIGH — Compounding Drift: 30% Band = 23x in 5 Seconds

**File:** `update_perk_oracle.rs:52-60`, `constants.rs`

**The Math:**
- Rate limit: one update per slot (~400ms)
- Band limit: 30% per update (3000 bps) for "deep liquidity" tokens
- After N updates, price can reach `original * 1.3^N`

| Time | Slots | Max Multiplier |
|------|-------|---------------|
| 2s   | 5     | 3.7x          |
| 5s   | 12    | 23x           |
| 10s  | 25    | 705x          |
| 30s  | 75    | 1.2e8x        |

A compromised cranker posting maximally-banded updates can **double the price in ~2 seconds** and **100x it in under 8 seconds**. The banding provides almost no protection against a persistent attacker — it only prevents single-update flash manipulation.

**Why This Matters:**  
Banding creates a **false sense of security**. If the admin sees "30% band" and assumes "price can't move more than 30%", they're wrong. The band is per-update, not per-time-window. Monitoring and freeze response must happen within **single-digit seconds** or the banding is meaningless.

**Severity:** HIGH — the security guarantee is weaker than the parameter suggests.

**Recommendation:**  
1. Add a **time-windowed cumulative cap** (e.g., "max 50% change within 60 seconds") using the stored EMA or a rolling window reference price
2. Or: use EMA as the banding reference instead of the last posted price — EMA smooths out sequential drift since `ema = (price + 9 * old_ema) / 10`
3. Document explicitly that banding is **per-update only** and monitoring must freeze within <3 seconds

---

### [H-02] HIGH — Hardcoded Jito Tip Accounts → Silent Degradation to Public Mempool

**File:** `oracle-cranker.ts:189-199`

**The Problem:**  
The 8 Jito tip accounts are hardcoded. Jito periodically rotates tip accounts. When they rotate:
1. Tip transfer goes to an invalid (non-tip) account
2. Jito block engine rejects the bundle
3. Cranker catches the error and **silently falls back** to normal RPC
4. All subsequent updates go through the **public mempool** — fully front-runnable

**The Attack:**  
An attacker who notices tip accounts have rotated (publicly verifiable) knows:
- All Perk oracle updates are now in the public mempool
- They can front-run every single update
- The cranker operator may not notice for hours/days (it just logs a fallback warning)

**Severity:** HIGH — complete loss of MEV protection without any alerting mechanism.

**Fix:**
1. Fetch current tip accounts from Jito's API at startup: `GET /api/v1/bundles/tip_accounts`
2. Cache with TTL (refresh every 5 minutes)
3. **Alert loudly** on fallback — this should trigger an ops page, not just a log line
4. Consider a circuit breaker: if Jito fails N times consecutively, **pause the cranker** rather than degrading silently

```typescript
private async getJitoTipAccount(): Promise<PublicKey> {
  // Fetch from API with cache
  if (!this.tipAccounts || Date.now() - this.tipAccountsFetchedAt > 300_000) {
    const res = await fetchWithTimeout(`${blockEngineUrl}/api/v1/bundles/tip_accounts`, { timeoutMs: 3000 });
    this.tipAccounts = (await res.json()) as string[];
    this.tipAccountsFetchedAt = Date.now();
  }
  return new PublicKey(this.tipAccounts[Math.floor(Math.random() * this.tipAccounts.length)]);
}
```

---

### [M-01] MEDIUM — Admin Config Race: Lower Band → Post Bad Price → Restore Band

**File:** `update_oracle_config.rs`

**The Attack (requires compromised admin OR colluding admin+cranker):**
1. Admin sets `max_price_change_bps = 0` (disables banding)
2. Cranker immediately posts manipulated price (unrestricted)
3. Admin sets banding back to 3000

This can happen in 3 transactions within a single slot. From the outside, it looks like banding was always active.

**Severity:** MEDIUM — requires admin compromise, but the config change leaves no on-chain trace of the temporary disable (just the config update events if someone is watching).

**Mitigation:**  
- Add a **timelock** on banding config changes (e.g., config changes take effect after N slots)
- Or: emit a prominently indexed event that monitoring can catch
- Consider requiring the oracle to be frozen before config changes

---

### [M-02] MEDIUM — Tight Band DoS: 1 bps Permanently Bricks Oracle

**File:** `update_perk_oracle.rs:52-60`

**The Scenario:**
- Admin sets `max_price_change_bps = 1` (0.01%)
- Real market price moves 0.02% in one slot (completely normal for any asset)
- Cranker's update is rejected: `OraclePriceInvalid`
- Cranker retries next slot — price has moved further — still rejected
- Oracle goes stale → positions can't be liquidated → bad debt accumulates

**The Attack:**  
An attacker doesn't need to do anything. They just need the admin to set a too-tight band. Legitimate market movement becomes a denial-of-service on the oracle. The cranker can never catch up because each update is compared to the last posted (now stale) price, and the real price keeps diverging.

**Severity:** MEDIUM — requires misconfiguration, but the failure mode is catastrophic (permanent oracle death until admin intervention).

**Mitigation:**
- Enforce a minimum banding value (e.g., `min_price_change_bps = 50` = 0.5%) if banding is enabled
- Add a "force update" mechanism where admin can push one update without banding (similar to unfreeze but without zeroing)

---

### [M-03] MEDIUM — Jito Fallback Exposes Updates to Front-Running

**File:** `oracle-cranker.ts:287-296`

**The Design Flaw:**  
When Jito submission fails, the cranker falls back to `this.client.updatePerkOracle()` via normal RPC. This sends the oracle update through the **public mempool**, where:
1. MEV bots see the pending price update
2. They can sandwich trades around it
3. If the price change is significant, they can front-run positions/liquidations

**Why It Matters:**  
The entire point of Jito integration is MEV protection. The fallback **silently and completely** negates it. An attacker who can cause Jito submission to fail (see M-01 on tip accounts, or just DDoS the block engine URL) gets all oracle updates in the public mempool.

**Griefing Vector:**  
An attacker could submit conflicting bundles to the same Jito block engine to increase bundle failure rate, forcing more frequent fallbacks. Cost: just the tip amount per grief attempt.

**Severity:** MEDIUM — the fallback is necessary for liveness, but the current implementation trades MEV protection for availability with no middle ground.

**Mitigation:**
1. Retry Jito 2-3 times with backoff before falling back
2. Use `skipPreflight: true` + `maxRetries: 0` on the RPC fallback to minimize mempool exposure time
3. Consider **not falling back** and instead waiting for the next tick to retry via Jito (sacrifice one update for MEV protection)

---

### [L-01] LOW — Overflow Check Is Sound but Relies on MAX_ORACLE_PRICE

**File:** `update_perk_oracle.rs:57`

**Analysis:**  
`diff.checked_mul(BPS_DENOMINATOR)` where:
- `diff` max = `MAX_ORACLE_PRICE` = 1e12
- `BPS_DENOMINATOR` = 10,000
- Product max = 1e16, well within `u64::MAX` (1.8e19)

✅ **No overflow possible** given the current `MAX_ORACLE_PRICE` constraint.

**However:** If `MAX_ORACLE_PRICE` is ever raised above `1.8e15` (1.8e19 / 10000), the `checked_mul` would return `Err(MathOverflow)`, which would **brick the oracle** (every update rejected). This is a safe failure mode (reverts, doesn't corrupt), but it's a latent DoS.

**Severity:** LOW — no current risk, but future constant changes could trigger it.

**Note:** Good use of `checked_mul` — this is exactly the right pattern.

---

### [L-02] LOW — Tip Instruction Hardcodes System Program Transfer Encoding

**File:** `oracle-cranker.ts:203-211`

The tip transfer is constructed manually:
```typescript
data: Buffer.from([
  2, 0, 0, 0, // transfer instruction index
  ...new BN(tipLamports).toArray("le", 8),
])
```

This is correct for the current System Program encoding (`Transfer = 2`), but:
1. It's fragile — if `@solana/web3.js` changes encoding or system program adds variants, this could break
2. Should use `SystemProgram.transfer()` instead for maintainability

**Severity:** LOW — currently correct, but unnecessarily fragile.

**Fix:**
```typescript
import { SystemProgram } from "@solana/web3.js";
const tipIx = SystemProgram.transfer({
  fromPubkey: payer.publicKey,
  toPubkey: tipAccount,
  lamports: tipLamports,
});
```

---

### [I-01] INFORMATIONAL — EMA Zeroed on Unfreeze Removes Smoothing History

**File:** `freeze_perk_oracle.rs:34`

On unfreeze, `ema_price` is set to 0. The first update after unfreeze sets `ema_price = params.price` (since ema_price == 0 triggers the initialization branch). This is correct but means all historical smoothing is lost. If EMA is ever used for banding reference (as recommended in H-01), this needs revisiting.

---

### [I-02] INFORMATIONAL — update_oracle_config Doesn't Require Oracle to Be Frozen

**File:** `update_oracle_config.rs`

Config changes take effect immediately on a live, actively-updating oracle. There's no freeze requirement or cooldown. This is fine for the current admin-trust model but creates a race window between config change and the next cranker update.

---

## Attack Tree Summary

```
Goal: Manipulate PerkOracle price for profit
├── [C-01] Exploit unfreeze → post any price (BYPASSES BANDING)
│   ├── Social-engineer admin to unfreeze after stale period
│   └── Compromised admin unfreezes for accomplice cranker
├── [H-01] Compound 30% drift per slot
│   ├── Compromised cranker posts max-band updates
│   └── 23x manipulation in 5 seconds
├── [M-01] Admin lowers band temporarily
│   ├── Disable banding → post bad price → restore banding
│   └── 3 transactions, same slot, no visible trace

Goal: Degrade MEV protection
├── [H-02] Stale tip accounts → silent RPC fallback
├── [M-03] Grief Jito submission → force public mempool
└── DDoS block engine URL → permanent fallback

Goal: Denial of Service
├── [M-02] Set tight band → oracle permanently bricked
└── [L-01] Future MAX_ORACLE_PRICE increase → overflow revert
```

---

## Recommendations (Priority Order)

| # | Finding | Fix | Effort |
|---|---------|-----|--------|
| 1 | C-01 | Store pre-freeze price in `_reserved[3..11]`, band first update against it | Small |
| 2 | H-01 | Add cumulative time-window cap or use EMA as band reference | Medium |
| 3 | H-02 | Fetch tip accounts from API, alert on fallback, circuit breaker | Small |
| 4 | M-01 | Timelock on config changes or require freeze before config update | Small |
| 5 | M-02 | Enforce minimum banding floor (50 bps) when non-zero | Trivial |
| 6 | M-03 | Retry Jito before fallback, minimize mempool exposure | Small |
| 7 | L-02 | Use `SystemProgram.transfer()` instead of manual encoding | Trivial |

---

*Predator out. Fix C-01 before mainnet or you're handing every compromised cranker a blank check.*
