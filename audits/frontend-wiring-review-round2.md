# Frontend SDK Wiring — Review Round 2

**Date:** 2025-03-25  
**Reviewer:** Kai (automated sub-agent)  
**Scope:** All 14 frontend files + SDK reference (client.ts, types.ts, math.ts, constants.ts)  
**Purpose:** Verify Round 1 fixes are correct; find new issues.

---

## Executive Summary

All 9 previously identified fixes are **verified correct**. Round 2 found **2 Medium**, **3 Low**, and **2 Informational** new issues — no new Critical or High severity bugs.

---

## Previous Fix Verification

### ✅ C-01: u128 fields use `parseFloat(bn.toString())` — VERIFIED

**MarketsProvider.tsx** lines for `baseReserve`, `quoteReserve`, `k`, `pegMultiplier` all use `parseFloat(m.field.toString())`. These values are stored in the frontend `Market` type for display/estimation only. The actual mark price calculation calls `calculateMarkPrice(m)` with the raw SDK `MarketAccount` (BN fields), which uses full BN arithmetic internally (1e12 precision multiplier). No precision issue for mark price.

**Minor note:** `parseFloat()` on u128 values >2^53 will lose trailing digits, but this only affects the frontend `Market.baseReserve` etc. used for slippage estimation — acceptable for a UI approximation.

### ✅ C-02: Collateral decimals use shared `getTokenDecimals(collateralMint)` — VERIFIED

**usePosition.ts** line 52: `const decimals = getTokenDecimals(collateralMint)` correctly uses collateralMint (not tokenMint). **token-meta.ts** returns SOL=9, default=6. `amountToNumber(pos.depositedCollateral, decimals)` correctly scales the on-chain amount.

### ✅ C-03: SOL wrapping before deposit — VERIFIED

**DepositWithdraw.tsx** lines 122-137: Creates WSOL ATA if missing → transfers native SOL → syncs native → sends as separate TX before deposit. The flow is functionally correct. See M-01 below for robustness concern.

### ✅ F-04: PnL uses `accountEquity()` — VERIFIED

**usePosition.ts** line 57: `const equity = accountEquity(pos)` uses the SDK's on-chain-matching formula (`max(0, collateral + pnl - feeDebt)`). Line 59: `pnl = equityHuman - collateralHuman` gives net PnL after fee debits. This correctly reflects the user's gain/loss from their deposited amount.

**Note:** The `max(0, ...)` clamp means deeply underwater positions show PnL = -collateral (total loss), which is correct — equity can't go below zero.

### ✅ H-03: Client-side validation — VERIFIED

**TradePanel.tsx** lines 81-90: Validates `sizeNum > 0`, `market.active`, and `leverage ≤ maxLeverage` before submitting. All guard clauses use `toast.error()` for feedback.

### ✅ H-04: MarketsProvider single polling — VERIFIED

**MarketsProvider.tsx**: Single `useEffect` creates one `setInterval(fetchMarkets, 10_000)`. All consumers (landing page, trade page, any component) share this single context via `useMarkets()` hook. No duplicate polling. `mountedRef` prevents state updates after unmount. When `fetchMarkets` identity changes (wallet connect/disconnect), the old interval is properly cleaned up.

### ✅ M-04: Slippage estimation — VERIFIED

**TradePanel.tsx** line 110: `slippagePct = Math.abs(sizeNum) / market.baseReserve`. For constant-product AMM (`x·y=k`), price impact ≈ `Δx / x` for small trades. This is a standard first-order approximation. Underestimates for large trades (>5% of reserves), but acceptable for a UI hint with the `~` prefix on display.

### ✅ I-01: Shared token-meta.ts — VERIFIED

**token-meta.ts** is the single source of truth. Imported in:
- `MarketsProvider.tsx` → `TOKEN_META`
- `usePosition.ts` → `getTokenSymbol`, `getTokenDecimals`

**Exception:** `DepositWithdraw.tsx` has a local duplicate `getDecimals()` — see L-01 below.

### ✅ I-03: Toasts replace alerts — VERIFIED

All 5 components use `toast.success()` / `toast.error()` from `react-hot-toast`:
- TradePanel.tsx ✓
- DepositWithdraw.tsx ✓
- CreateMarketForm.tsx ✓
- Positions.tsx ✓
- TriggerOrders.tsx ✓

**layout.tsx** includes `<Toaster>` with dark theme styling (bg `#0f0f11`, white text, mono font, border). Position: `bottom-right`.

---

## New Issues Found

### M-01: SOL wrapping and deposit are separate transactions — no atomicity

**File:** `DepositWithdraw.tsx` lines 122-141  
**Severity:** Medium  
**Impact:** If the wrapping TX succeeds but the subsequent `client.deposit()` TX fails (e.g., insufficient compute, program error, user rejects second TX), the user is left with WSOL in their ATA and no deposit. They must either retry the deposit manually or close the WSOL ATA to recover their SOL.

**Current flow:**
```
TX1: create WSOL ATA + transfer SOL + syncNative  →  confirm
TX2: SDK deposit(tokenMint, oracle, amount)        →  may fail
```

**Recommendation:** Combine wrapping instructions and deposit instruction into a single transaction. The SDK's `preInstructions` field supports this pattern — build the deposit instruction, prepend the wrapping instructions, send as one atomic TX. Alternatively, add a try/catch around the deposit that unwraps WSOL on failure:

```ts
try {
  await client.deposit(tokenMint, oracle, amountBN);
} catch (err) {
  // Attempt to close WSOL ATA to return SOL
  const closeTx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, publicKey, publicKey)
  );
  await provider.sendAndConfirm(closeTx);
  throw err;
}
```

### M-02: Wallet balance checks tokenMint instead of collateralMint

**File:** `DepositWithdraw.tsx` lines 49-62  
**Severity:** Medium  
**Impact:** For markets where `tokenMint ≠ collateralMint` (e.g., a BONK-PERP market with SOL collateral), the wallet balance display shows the user's BONK balance instead of their SOL balance. The user sees the wrong available balance for deposit.

**Current code:**
```ts
if (market.tokenMint === SOL_MINT) {
  const bal = await connection.getBalance(publicKey);
```

**Should be:**
```ts
if (market.collateralMint === SOL_MINT) {
  const bal = await connection.getBalance(publicKey);
```

And line 57 should fetch the ATA for `market.collateralMint`, not `market.tokenMint`:
```ts
const mint = new PublicKey(market.collateralMint);
```

**Note:** If the current protocol always sets `collateralMint == tokenMint`, this bug is latent. But the code should be correct for the general case, especially since the `decimals` variable already correctly uses `market.collateralMint`.

### L-01: DepositWithdraw.tsx duplicates `getDecimals` instead of importing shared module

**File:** `DepositWithdraw.tsx` lines 25-27  
**Severity:** Low  
**Impact:** Local `getDecimals()` function duplicates `getTokenDecimals()` from `token-meta.ts`. Logic is identical (SOL=9, default=6), but having two copies risks divergence if token-meta is updated.

**Fix:** Replace with `import { getTokenDecimals } from "@/lib/token-meta"` and use `getTokenDecimals(market.collateralMint)`.

### L-02: Positions.tsx uses array index for close-tracking state

**File:** `Positions.tsx` line 18, 35, 53  
**Severity:** Low  
**Impact:** `closingIndex` tracks which position is being closed by its array index. If the positions array reorders or changes length during the 5-second polling cycle (from `usePositions`), the "..." loading indicator could briefly appear on the wrong row.

**Fix:** Use the stable composite key instead:
```ts
const [closingKey, setClosingKey] = useState<string | null>(null);
// ...
setClosingKey(`${pos.authority}-${pos.market}`);
// ...
const isClosing = closingKey === `${p.authority}-${p.market}`;
```

### L-03: `connection` missing from `handleSubmit` dependency array

**File:** `DepositWithdraw.tsx` line 150  
**Severity:** Low  
**Impact:** `handleSubmit` uses `connection` for `getLatestBlockhash()` and `getTokenAccountBalance()` during SOL wrapping, but `connection` is not in the `useCallback` dependency array. If the RPC connection changes (e.g., user switches network), the callback would use a stale reference.

**Fix:** Add `connection` to the dependency array:
```ts
}, [client, publicKey, amount, mode, market, scale, connection]);
```

### I-01: CreateMarketForm.tsx still imports from `mock-data`

**File:** `CreateMarketForm.tsx` line 4  
**Severity:** Informational  
**Impact:** `MOCK_TOKEN_LIST` is imported from `@/lib/mock-data`. This is a curated token list used for the search dropdown, not fake market data — so it's functionally fine. But the `MOCK_` prefix is misleading and the file also exports `MOCK_MARKETS`, `MOCK_POSITIONS`, and `MOCK_TRIGGER_ORDERS` that are no longer used in active code paths.

**Recommendation:** Extract the token list to a dedicated `@/lib/known-tokens.ts` (or add it to `token-meta.ts`) and rename from `MOCK_TOKEN_LIST` to `KNOWN_TOKENS`. Remove unused mock exports from `mock-data.ts` or delete the file if nothing else imports it.

### I-02: No WSOL unwrap on withdrawal from SOL-collateral markets

**File:** `DepositWithdraw.tsx`  
**Severity:** Informational  
**Impact:** When withdrawing from a SOL-collateral market, the SDK transfers WSOL to the user's ATA. There's no automatic unwrap step to convert WSOL back to native SOL. Users would need to close their WSOL ATA manually (most wallets handle this, but it's not guaranteed).

**Recommendation:** After a successful withdrawal from a SOL-collateral market, add a `closeAccount` instruction to unwrap WSOL:
```ts
if (market.collateralMint === SOL_MINT) {
  const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
  const unwrapTx = new Transaction().add(
    createCloseAccountInstruction(wsolAta, publicKey, publicKey)
  );
  await provider.sendAndConfirm(unwrapTx);
}
```

---

## Architecture Observations (No Action Required)

### MarketsProvider → useMarkets → useMarket chain

The data flow is clean:
1. `MarketsProvider` polls `fetchAllMarkets()` every 10s, maps to frontend `Market[]`
2. `useMarkets()` returns the shared context (no additional fetching)
3. `useMarket(symbol)` filters the array by symbol — O(n) per render but n is small

No race conditions. The `mountedRef` pattern correctly prevents state updates after unmount. Re-renders from wallet changes properly clean up old intervals.

### usePositions polling

Each mount of `usePositions` creates its own 5-second polling loop. Currently only one component (`usePositionsForMarket` in the trade page) calls it, so there's no duplication. If multiple components need positions in the future, consider promoting this to a context provider (like MarketsProvider).

### parseFloat precision for u128 display

`parseFloat(bn.toString())` for `baseReserve`, `quoteReserve`, `k`, `pegMultiplier` loses precision beyond 2^53 (~9e15). For typical Solana perps markets, reserves are well within this range. The values are only used for slippage estimation and display — the actual on-chain math uses BN. Acceptable.

### react-hot-toast integration

Properly integrated: `<Toaster>` in layout.tsx with dark theme, all components use `toast.success`/`toast.error`. The `position="bottom-right"` keeps toasts out of the trading UI. Custom styling matches the app's design system.

---

## Summary

| Severity | Count | Status |
|----------|-------|--------|
| Critical | 0 | — |
| High | 0 | — |
| Medium | 2 | M-01, M-02 |
| Low | 3 | L-01, L-02, L-03 |
| Informational | 2 | I-01, I-02 |

All 9 Round 1 fixes verified correct. The codebase is significantly improved. The two Medium issues (SOL wrap atomicity, collateralMint vs tokenMint balance display) should be addressed before mainnet.
