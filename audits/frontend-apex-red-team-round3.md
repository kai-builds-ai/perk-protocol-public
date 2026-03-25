# Perk Protocol — Frontend Red Team Audit (Round 3)

**Date:** 2026-03-25  
**Auditor:** Apex (adversarial red team)  
**Scope:** All 14 frontend files + SDK cross-reference  
**Prior rounds:** Round 1 (3C/5H, all fixed), Round 2 (2C/3H, all fixed)  
**Methodology:** Full-code adversarial review targeting 10 specific attack vectors + opportunistic hunting

---

## Executive Summary

The codebase is in strong shape after two rounds of fixes. No critical vulnerabilities remain. I found **1 High**, **2 Medium**, and **4 Low** severity issues, plus 2 informational notes. The most impactful finding is the non-atomic WSOL unwrapping after SOL withdrawals — the M-02 fix from Round 2 addressed the missing close but uses a separate transaction, creating a fund-lock risk.

---

## Findings

### H-01: Non-Atomic WSOL ATA Close After SOL Withdraw (Fund-Lock Risk)

**File:** `DepositWithdraw.tsx` lines ~130-141  
**Severity:** HIGH  
**Status:** NEW (partial regression of Round 2 M-02 fix)

The SOL withdrawal flow sends two separate transactions:
1. `client.withdraw(tokenMint, oracle, amountBN)` — withdraws WSOL to user's ATA
2. A separate `sendAndConfirm` to close the WSOL ATA and return native SOL

```typescript
const sig = await client.withdraw(tokenMint, oracle, amountBN);
if (isSOLCollateral) {
  try {
    const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
    const closeTx = new (await import("@solana/web3.js")).Transaction().add(
      createCloseAccountInstruction(wsolAta, publicKey, publicKey),
    );
    await (client as any).provider.sendAndConfirm(closeTx);
  } catch (closeErr) {
    console.warn("WSOL ATA close failed (non-critical):", closeErr);
  }
}
```

**Attack scenario:**
1. User withdraws 5 SOL from vault → TX 1 succeeds, WSOL lands in ATA
2. Wallet prompts for TX 2 (close ATA) → user rejects, closes tab, or network fails
3. User now has WSOL stuck in their ATA with no native SOL returned
4. The error is caught and logged as "non-critical" — user gets a success toast for the withdraw but never receives native SOL

**Secondary issue:** `createCloseAccountInstruction` sends ALL lamports in the WSOL ATA to the user, not just the withdrawal amount. If the user had pre-existing WSOL from another source, it all gets unwrapped. This isn't exploitable (user gets their own SOL) but could be confusing.

**Fix:** Build the withdraw + close as a single atomic transaction. Since the SDK only supports `preInstructions` (not post), manually construct the transaction:

```typescript
// Build withdraw IX via program methods
const withdrawIx = await client.program.methods
  .withdraw(amountBN)
  .accounts({ /* ... */ })
  .instruction();

// Build close ATA IX
const closeIx = createCloseAccountInstruction(wsolAta, publicKey, publicKey);

// Send as one TX
const tx = new Transaction().add(...client.preInstructions, withdrawIx, closeIx);
await client.provider.sendAndConfirm(tx);
```

---

### M-01: `isSubmitting` Race Window Allows Double-Submit

**File:** `TradePanel.tsx`  
**Severity:** MEDIUM

The `isSubmitting` guard uses React state:
```typescript
const [isSubmitting, setIsSubmitting] = useState(false);
// ...
const handleSubmit = useCallback(async () => {
  if (!Number.isFinite(sizeNum) || sizeNum <= 0) return;
  // ...
  setIsSubmitting(true);  // <-- state update, not synchronous
```

The button is disabled via:
```typescript
disabled={!sizeNum || isSubmitting}
```

**Attack scenario:** React state updates are asynchronous. Between a click event firing `handleSubmit` and React re-rendering to disable the button, a second click event can queue. Both invocations would see `isSubmitting === false` and proceed, opening two identical positions.

While extremely tight timing-wise (requires two clicks within ~16ms on a 60fps render cycle), this is a real pattern that can occur with:
- Fast double-clicks
- Keyboard Enter key repeat
- Automated/accessibility tools

**Applies to:** `TradePanel.handleSubmit`, `DepositWithdraw.handleSubmit`, `CreateMarketForm.handleCreate`

**Fix:** Use a ref as a synchronous lock in addition to state:
```typescript
const submittingRef = useRef(false);

const handleSubmit = useCallback(async () => {
  if (submittingRef.current) return;
  submittingRef.current = true;
  setIsSubmitting(true);
  try { /* ... */ }
  finally {
    submittingRef.current = false;
    setIsSubmitting(false);
  }
}, [...]);
```

---

### M-02: Non-Atomic Position Init + Trade (Two-TX Pattern)

**File:** `TradePanel.tsx` lines ~92-99, `DepositWithdraw.tsx` lines ~107-113  
**Severity:** MEDIUM

Multiple flows use a check-then-create-then-act pattern across separate transactions:

```typescript
// Ensure position account exists
try {
  await client.fetchPosition(marketAddr, publicKey);
} catch {
  await client.initializePosition(tokenMint);  // TX 1
}
const sig = await client.openPosition(...);      // TX 2
```

**Issues:**
1. **Wasted rent on failure:** If TX 1 succeeds (position initialized) but TX 2 fails (insufficient collateral, slippage, etc.), the user pays rent for an empty position account they may never use.
2. **Error conflation:** The `catch` block catches ALL errors from `fetchPosition`, not just "account doesn't exist." A network timeout or RPC error would trigger `initializePosition`, which could fail if the position already exists, producing a confusing double error.
3. **Two wallet prompts:** User must approve two transactions, degrading UX.

**Fix:** Use the SDK's `preInstructions` to include `initializePosition` as a pre-instruction to the main operation, making it atomic. Or, use `fetchNullable`-style calls that return null instead of throwing.

---

### L-01: TOCTOU Race in WSOL ATA Existence Check

**File:** `DepositWithdraw.tsx` lines ~116-122  
**Severity:** LOW

```typescript
try {
  await connection.getTokenAccountBalance(wsolAta);
} catch {
  preIxs.push(createAssociatedTokenAccountInstruction(
    publicKey, wsolAta, publicKey, NATIVE_MINT
  ));
}
```

The check (getTokenAccountBalance) and the use (TX execution) are not atomic. If another transaction creates the WSOL ATA between the check and TX submission, `createAssociatedTokenAccountInstruction` will fail because the account already exists.

**Fix:** Use `createAssociatedTokenAccountIdempotentInstruction` from `@solana/spl-token` which succeeds even if the account exists. Always include it — no check needed:
```typescript
preIxs.push(createAssociatedTokenAccountIdempotentInstruction(
  publicKey, wsolAta, publicKey, NATIVE_MINT
));
```

---

### L-02: Floating-Point Precision Loss in Amount Conversion

**File:** `DepositWithdraw.tsx` line ~109  
**Severity:** LOW

```typescript
const amountBN = new BN(Math.floor(amountNum * scale));
```

IEEE 754 floating-point arithmetic causes subtle precision errors:
- `0.3 * 1e9` = `299999999.99999994` → `Math.floor` = `299999999` (1 lamport short)
- `1.05 * 1e6` = `1049999.9999999998` → 1 unit short

Users will occasionally deposit/withdraw 1 base unit less than intended. While individually trivial, this is a correctness issue.

**Fix:** Parse the decimal string directly into a BN:
```typescript
function decimalToBN(input: string, decimals: number): BN {
  const [whole = "0", frac = ""] = input.split(".");
  const paddedFrac = frac.padEnd(decimals, "0").slice(0, decimals);
  return new BN(whole + paddedFrac);
}
```

---

### L-03: `parseFloat` Precision Loss on Large BN Values

**File:** `MarketsProvider.tsx` lines ~54-57  
**Severity:** LOW

```typescript
baseReserve: parseFloat(m.baseReserve.toString()),
quoteReserve: parseFloat(m.quoteReserve.toString()),
k: parseFloat(m.k.toString()),
pegMultiplier: parseFloat(m.pegMultiplier.toString()),
```

`k` is at minimum 1e18 (above `Number.MAX_SAFE_INTEGER` = 9.007e15). Converting via `parseFloat` loses precision. The `baseReserve` is used in `TradePanel` for slippage estimation:
```typescript
const slippagePct = market.baseReserve > 0
  ? Math.abs(sizeNum) / market.baseReserve : 0;
```

Since `baseReserve` is a large BN converted to float, the slippage estimate has reduced precision for markets with very large reserves. In practice the error is tiny (< 0.001%) because IEEE 754 doubles have 15-17 significant digits.

**Fix:** For display-only fields this is acceptable. If precise arithmetic is needed, keep as string or use a big-number library on the frontend.

---

### L-04: Default Token Decimals May Be Wrong for Unknown Tokens

**File:** `token-meta.ts` line ~32  
**Severity:** LOW

```typescript
export function getTokenDecimals(mint: string): number {
  return TOKEN_DECIMALS[mint] ?? 6;
}
```

If a user creates a market with a custom token whose decimals differ from 6 (e.g., 9 for most SPL tokens, 0 for some NFT-style tokens), all deposit/withdraw amounts and position displays would be scaled incorrectly. A 9-decimal token with default 6 would show balances 1000x too large.

**Current mitigation:** Only known tokens are in `TOKEN_DECIMALS`. The `CreateMarketForm` allows arbitrary mints.

**Fix:** Query `getMint()` on-chain to fetch actual decimals for unknown tokens, or store decimals in the market account on-chain and read them during market fetch.

---

## Informational

### I-01: `||` vs `??` for Price Fallback

**File:** `trade/[token]/page.tsx` line ~24

```typescript
markPrice: livePrice || market.markPrice,
```

The `||` operator treats `0` as falsy. If Pyth ever returns a price of `0` (e.g., during an oracle outage or extreme crash), the UI would silently fall back to the stale market price instead of displaying 0. Using `??` would only fall back on `null`/`undefined`.

**Impact:** Essentially zero for real markets (price = 0 is unreachable), but `??` is more semantically correct.

---

### I-02: Error Conflation in Position Existence Check

**File:** `TradePanel.tsx` lines ~92-96, `DepositWithdraw.tsx` lines ~107-111

```typescript
try {
  await client.fetchPosition(marketAddr, publicKey);
} catch {
  // Assumes "account doesn't exist" — but could be network error, RPC timeout, etc.
  await client.initializePosition(tokenMint);
}
```

A transient RPC failure would be misinterpreted as "position doesn't exist," triggering an unnecessary (and potentially failing) `initializePosition` call. The resulting error message would be confusing: "Account already initialized" instead of "Network error."

**Fix:** Check the error type — Anchor's `fetchNullable` returns null for missing accounts vs throwing for network errors. Or inspect the error code.

---

## Verified Attack Vectors (No Issues Found)

| Vector | Result |
|--------|--------|
| **Atomic SOL wrapping (deposit)** | ✅ `PerkClient` accepts `preInstructions`, deposit prepends them atomically. Confirmed in SDK. |
| **Generation counter overflow/race** | ✅ `++generationRef.current` is synchronous JS. Counter won't reach 2^53 in practice. |
| **BONK decimals** | ✅ Listed as 5 — matches on-chain mint. |
| **PnL display misleading** | ✅ `equity - collateral` correctly shows net PnL (fees included). Underwater positions clamp to -100%. |
| **Trigger order cancel spoofing** | ✅ PDA derived from `wallet.publicKey` — can only cancel own orders. |
| **XSS via token metadata** | ✅ React auto-escapes JSX text. No `dangerouslySetInnerHTML` anywhere in codebase. |
| **Memory leaks** | ✅ All `setInterval` paired with `clearInterval`. `mountedRef` pattern correct in `usePositions`. Keyboard listener cleaned up. |
| **CreateMarket malicious mint** | ✅ Frontend validates pubkey format. On-chain program would reject non-existent mints at the account level. |

---

## Summary Table

| ID | Severity | Title | Status |
|----|----------|-------|--------|
| H-01 | HIGH | Non-atomic WSOL close after withdraw | NEW |
| M-01 | MEDIUM | isSubmitting race window (double-submit) | NEW |
| M-02 | MEDIUM | Non-atomic position init + trade | NEW |
| L-01 | LOW | TOCTOU race in WSOL ATA existence check | NEW |
| L-02 | LOW | Float precision loss in amount conversion | NEW |
| L-03 | LOW | parseFloat precision loss on large BN | NEW |
| L-04 | LOW | Default decimals wrong for unknown tokens | NEW |
| I-01 | INFO | `\|\|` vs `??` for price fallback | NEW |
| I-02 | INFO | Error conflation in position existence check | NEW |

---

*Apex Red Team — Round 3 complete. The codebase has improved significantly. The remaining issues are edge cases and UX concerns, with H-01 being the only finding that could result in user fund inconvenience.*
