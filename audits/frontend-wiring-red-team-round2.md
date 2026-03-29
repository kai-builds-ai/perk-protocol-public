# Frontend Wiring — Red Team Round 2

**Date:** 2026-03-25  
**Auditor:** Kai (subagent)  
**Scope:** All 12 frontend files + SDK client/math/constants  
**Goal:** Break the fixes from Round 1 (3 Critical, 5 High — all marked fixed)

---

## Summary

| Severity | Count | Description |
|----------|-------|-------------|
| 🔴 Critical | 2 | SOL wrapping non-atomic fund loss, wrong mint in deposit/withdraw |
| 🟠 High | 3 | PnL double-counts fee debt, `Infinity` trade size bypass, stale client in polling |
| 🟡 Medium | 4 | Mock data in production, no WSOL cleanup, decimal default unsafe, balance shows wrong token |
| 🔵 Low | 3 | Leverage=0 accepted, missing wallet/vault balance guards, toast z-index |

**Verdict:** Round 1 fixes introduced 2 new critical bugs. Not ready to ship.

---

## 🔴 Critical

### C-01: SOL Wrapping Is Non-Atomic — User Fund Loss on Deposit Failure

**File:** `DepositWithdraw.tsx` lines 114–135  
**Fix claimed:** C-03 from Round 1  

The SOL wrapping flow sends **two separate transactions**:
1. Wrap SOL → WSOL ATA (`wrapTx` via `provider.sendAndConfirm`)
2. Deposit WSOL into vault (`client.deposit`)

**Attack vectors:**
- **Wrap succeeds, deposit fails** (e.g., position not initialized, oracle stale, insufficient collateral for minimum): User's SOL is now locked as WSOL in their ATA with no automatic recovery path. The UI shows an error toast but the WSOL just sits there.
- **Previous failed wraps accumulate**: `SystemProgram.transfer` + `syncNative` *adds* to the existing WSOL ATA balance. If a user failed a deposit before, the ATA already has WSOL. The next wrap adds more SOL on top. The deposit amount BN only reflects the *current* attempt, not the accumulated WSOL — so the vault gets the right amount but excess WSOL is permanently stranded.
- **`(client as any).provider.sendAndConfirm(wrapTx)` is unsafe**: The `AnchorProvider.sendAndConfirm` method exists but the cast to `any` bypasses type checking. If the provider implementation changes (e.g., different wallet adapter), this silently breaks at runtime with no compile-time warning.

**Impact:** Direct fund loss. Users can lose SOL with no recovery mechanism in the UI.

**Fix:** Either:
1. Combine wrap + deposit into a single atomic transaction (preferred — Anchor supports `preInstructions`), or
2. Add a "close WSOL ATA" button to recover stranded funds, plus try/catch around deposit that auto-closes WSOL ATA on failure.

---

### C-02: DepositWithdraw Fetches Wallet Balance for `tokenMint` but Deposits `collateralMint`

**File:** `DepositWithdraw.tsx` lines 60–78 (wallet balance) vs lines 109–135 (deposit logic)  

The wallet balance display fetches the balance of `market.tokenMint`:
```ts
if (market.tokenMint === SOL_MINT) {
  const bal = await connection.getBalance(publicKey);
```

But deposits wrap/send `collateralMint` (which may differ from `tokenMint`). For markets where `collateralMint ≠ tokenMint` (e.g., a BONK-PERP market with USDC collateral), the UI shows the wrong balance entirely. The user sees their BONK balance but deposits USDC.

Similarly, the vault balance fetch at line 83 uses `market.tokenMint` to derive the market address (which is correct for PDA derivation) but displays it as `market.symbol` — which is the trading token, not the collateral token.

**Impact:** User sees misleading balance, could attempt to deposit an amount they don't have (of the collateral token), or not realize they need a different token entirely.

**Fix:** Wallet balance should query `market.collateralMint`, not `market.tokenMint`. Display label should say the collateral symbol, not the market symbol.

---

## 🟠 High

### H-01: PnL Calculation Double-Counts Fee Debt

**File:** `usePosition.ts` lines 52–57  
**Fix claimed:** F-04 from Round 1  

```ts
const equity = accountEquity(pos);           // = max(0, collateral + pnl - feeDebt)
const equityHuman = amountToNumber(equity, decimals);
const pnl = equityHuman - collateralHuman;   // = (collateral + pnl - feeDebt) - collateral
                                              // = pnl - feeDebt
```

The SDK's `accountEquity` is defined as `max(0, collateral + pnl - feeDebt)`. So:
- `equity - collateral = pnl - feeDebt` (not pure PnL)
- Fee debt is subtracted from PnL, making displayed PnL worse than actual
- If a position has accrued $50 in funding fees (feeDebt), the PnL shows $50 worse than the actual trading PnL
- For bankrupt positions (equity clamped to 0), PnL = -collateral, which hides the actual extent of loss

The frontend labels this as "PnL" but it's actually "PnL net of fees" — misleading for users trying to evaluate their trading performance vs. fee costs.

More critically: `feeCredits` can be **positive** (fee rebates). In `accountEquity`, positive `feeCredits` are treated as `feeDebt = 0` (the `isNeg()` check), so fee credits are silently ignored in equity. This means positions with positive fee credits show lower equity than they should, and the PnL underreports.

**Impact:** Misleading PnL display. Users may close profitable positions thinking they're losing money, or vice versa. Fee credits are silently dropped.

**Fix:** Either:
1. Display "PnL (net)" with a tooltip explaining it includes fees, or
2. Fetch `pos.pnl` directly from the position account and convert it separately from fees.

---

### H-02: `Infinity` Size Bypasses Validation in TradePanel

**File:** `TradePanel.tsx` line 48 + line 84  

```ts
const sizeNum = parseFloat(size) || 0;  // line 48
// ...
if (!sizeNum || sizeNum <= 0) return;   // line 84
```

If a user types `Infinity` into the size input (or a very large number that `parseFloat` returns as `Infinity`):
- `parseFloat("Infinity") = Infinity`
- `Infinity || 0 = Infinity` (truthy, not zero)
- `!Infinity = false`, `Infinity <= 0 = false` → validation passes
- `Math.floor(Infinity * POS_SCALE) = Infinity` → `new BN(Infinity)` behavior is undefined/crashes

Even without literal "Infinity", `parseFloat("1e309")` returns `Infinity`.

Similarly, `parseFloat("NaN")` returns `NaN`, and `NaN || 0 = 0`, so `!0 = true` → returns early. **NaN is safe.**

But `Infinity` is not caught anywhere in the validation chain until it hits BN construction, which may throw an obscure error or produce garbage.

**Impact:** Uncaught runtime error with confusing error message. Potential for garbage transaction submission.

**Fix:** Add `if (!Number.isFinite(sizeNum)) return;` after parsing.

---

### H-03: MarketsProvider Captures Stale Client on Connection Change

**File:** `MarketsProvider.tsx` lines 103–118  

```ts
const fetchMarkets = useCallback(async () => {
  const perkClient = client ?? readonlyClient;
  // ...
}, [client, readonlyClient]);

useEffect(() => {
  fetchMarkets();
  const interval = setInterval(fetchMarkets, POLL_INTERVAL);
  return () => { clearInterval(interval); };
}, [fetchMarkets]);
```

The `useCallback` correctly depends on `[client, readonlyClient]`, and the effect depends on `[fetchMarkets]`. When `readonlyClient` changes (because `connection` changed in PerkProvider), the memo chain propagates correctly.

**However:** `readonlyClient` in PerkProvider depends on `[connection]`:
```ts
const readonlyClient = useMemo(() => { ... }, [connection]);
```

If the RPC endpoint changes (e.g., user switches networks), a new `readonlyClient` is created, `fetchMarkets` gets a new identity, the effect cleans up and re-runs. **This is correct.**

**But** there's a subtle issue: between the cleanup of the old interval and the setup of the new one, the old `fetchMarkets` may still be in-flight (async). The `mountedRef` is set to `false` and then immediately back to `true` in the new effect. If the old fetch completes between those two statements, `mountedRef.current` is already `true` (set by the new effect) and the stale data from the OLD connection gets written to state.

**Race condition window:** Cleanup sets `mountedRef = false` → new effect sets `mountedRef = true` → old in-flight fetch finishes, sees `mountedRef = true`, writes stale data.

**Impact:** Stale market data from wrong network displayed briefly after RPC switch. Low likelihood but real race condition.

**Fix:** Use an abort controller or a fetch generation counter instead of a boolean ref:
```ts
const generationRef = useRef(0);
useEffect(() => {
  const gen = ++generationRef.current;
  // In fetch: if (gen !== generationRef.current) return;
```

---

## 🟡 Medium

### M-01: `MOCK_TOKEN_LIST` Still Used in CreateMarketForm (Production Code)

**File:** `CreateMarketForm.tsx` line 4  
**Also:** `usePythCandles.ts` lines 6, 18, 28, 45 (MOCK_CANDLES)

```ts
import { MOCK_TOKEN_LIST } from "@/lib/mock-data";
```

`CreateMarketForm` renders `MOCK_TOKEN_LIST` in its dropdown — these are hardcoded tokens with fake liquidity numbers. While the custom mint address flow works, the default dropdown shows stale/fake data.

`usePythCandles.ts` falls back to `MOCK_CANDLES` when Pyth data isn't available, showing fabricated price history to users.

**Impact:** Users see fake liquidity figures and potentially fake price candles. Misleading but not directly exploitable.

**Fix:** Replace with on-chain token list or Jupiter token API. Remove mock-data.ts entirely or gate it behind `process.env.NODE_ENV === 'development'`.

---

### M-02: No WSOL ATA Cleanup After Withdraw

**File:** `DepositWithdraw.tsx`  

The withdraw flow calls `client.withdraw()` which sends WSOL back to the user's ATA. But for SOL-collateral markets, the WSOL ATA is never closed after withdrawal. The user ends up with a WSOL token account holding their withdrawn funds as wrapped SOL, not native SOL.

To get their SOL back, they'd need to manually close the WSOL ATA (e.g., via a separate tool). Most users won't know how to do this.

**Impact:** User confusion. Funds are recoverable but require external tooling. Combined with C-01, WSOL can accumulate from failed deposits + successful withdrawals.

**Fix:** After a successful withdrawal from a SOL-collateral market, close the WSOL ATA with `createCloseAccountInstruction` (already imported but unused).

---

### M-03: `getTokenDecimals` Defaults to 6 — Unsafe for Many Tokens

**File:** `token-meta.ts` line 32  

```ts
export function getTokenDecimals(mint: string): number {
  return TOKEN_DECIMALS[mint] ?? 6;
}
```

Only SOL (9 decimals) is in `TOKEN_DECIMALS`. Every other token defaults to 6. While USDC/USDT are 6 decimals, several common SPL tokens have different decimal counts:
- BONK: 5 decimals
- RAY: 6 ✓
- JTO: 9 decimals
- JUP: 6 ✓
- ORCA: 6 ✓
- wBTC (Portal): 8 decimals

If JTO is used as collateral and has 9 decimals, defaulting to 6 would scale amounts by 10^6 instead of 10^9, making deposits 1000x too large and withdrawals 1000x too small.

**Impact:** Incorrect collateral scaling for tokens not in the map. Could cause deposits to fail (insufficient balance) or withdrawals to return dust amounts.

**Fix:** Either query on-chain `Mint.decimals` at runtime, or populate `TOKEN_DECIMALS` for every token in `TOKEN_META`.

---

### M-04: Wallet Balance Display Shows Trading Token, Not Collateral Token

**File:** `DepositWithdraw.tsx` lines 141, 146  

```tsx
<span className="font-mono text-white">
  {displayWallet} {market.symbol}   // Shows "SOL" or "BONK" etc.
</span>
```

The labels show `market.symbol` (the trading token) but the balance should reference the collateral token. For a BONK-PERP market collateralized by USDC, this would show "1000.0000 BONK" when it should show "1000.0000 USDC".

**Impact:** Confusing UX. Related to C-02 — both the value and label are wrong.

---

## 🔵 Low

### L-01: Leverage = 0 Not Explicitly Rejected

**File:** `TradePanel.tsx`  

The leverage slider starts at some value and the UI validates `leverage > market.maxLeverage` but never checks `leverage < 1` or `leverage === 0`. The SDK validates `leverage >= MIN_LEVERAGE (200)` at the `openPosition` call, so it would fail with a confusing SDK error rather than a clean UI message.

**Fix:** Add `if (leverage < 1) { toast.error("Minimum leverage is 1x"); return; }` in `handleSubmit`.

---

### L-02: No Client-Side Balance Guards on Deposit/Withdraw

**File:** `DepositWithdraw.tsx`  

The wallet balance and vault balance are fetched and displayed, but `handleSubmit` never checks:
- Deposit amount > wallet balance
- Withdraw amount > vault balance

The on-chain program will reject these, but the error message will be an opaque Anchor error instead of a friendly "Insufficient balance" toast.

**Fix:** Add pre-submission checks: `if (mode === "deposit" && walletBalance !== null && amountNum > walletBalance) { toast.error("Insufficient wallet balance"); return; }`

---

### L-03: Toast Z-Index May Conflict with Wallet Modal

**File:** `layout.tsx`  

The `Toaster` component doesn't set a custom `z-index`. The `@solana/wallet-adapter-react-ui` modal typically renders at `z-index: 1040+`. If a toast fires while the wallet modal is open (e.g., connection error), the toast may render behind the modal.

**Fix:** Add `containerStyle={{ zIndex: 9999 }}` to the `Toaster` props.

---

## Observations (Not Bugs)

### O-01: Slippage Estimate Uses `parseFloat(bn.toString())` for Large Reserves

**File:** `MarketsProvider.tsx` line 67  

```ts
baseReserve: parseFloat(m.baseReserve.toString()),
```

For u128 values up to ~3.4e38, `parseFloat` loses precision beyond ~15-16 significant digits. The slippage estimate in TradePanel uses:
```ts
const slippagePct = market.baseReserve > 0 ? Math.abs(sizeNum) / market.baseReserve : 0;
```

This is a rough `dx/x` approximation anyway, so parseFloat precision loss doesn't materially affect the already-approximate estimate. However, if `baseReserve` is astronomically large (>1e18), the estimate could be off by orders of magnitude. In practice, reserves are typically in the 1e12-1e15 range where parseFloat is fine.

**Verdict:** Acceptable for UI display. Not a bug.

### O-02: First Render Shows Empty Markets

Components handle `markets: []` gracefully (landing page shows empty table, stats show 0). The `loading` state is `true` initially, though no component currently renders a loading spinner — they just show empty state. This is fine but could be improved UX.

### O-03: `k` Field Precision

The `k` value (stored as u128) is converted via `parseFloat(m.k.toString())`. This field is used in `toFrontendMarket` but never used for any arithmetic in the frontend — slippage is estimated via the simple `size/baseReserve` ratio, not the constant-product formula. So precision loss in `k` is harmless.

---

## Fixes Verified ✅

| Round 1 ID | Fix | Verdict |
|------------|-----|---------|
| C-01 | parseFloat(bn.toString()) for u128 fields | ✅ Works (precision loss acceptable for display) |
| C-02 | POS_SCALE/PRICE_SCALE proper usage | ✅ Correct in all conversions |
| H-01 | Validation in TradePanel | ⚠️ Incomplete — misses Infinity (H-02 above) |
| H-02 | Toast error handling | ✅ All catch blocks show toast + console.error |
| H-03 | Client-side validation | ⚠️ Incomplete — misses leverage=0, balance checks |
| H-04 | Oracle fallback | ✅ Proper null handling with SystemProgram sentinel |
| H-05 | Position init before operations | ✅ All flows check/init position first |
| F-04 | accountEquity for PnL | ⚠️ Introduced fee-debt double-count (H-01 above) |
| C-03 | SOL wrapping | ❌ Non-atomic, introduces fund-loss risk (C-01 above) |

---

## Recommendation

**Do not ship.** Two critical issues need resolution:
1. SOL wrapping must be atomic (single transaction with preInstructions)
2. DepositWithdraw must use `collateralMint` for balance queries and display

After fixing, a Round 3 review is warranted for the wrapping refactor specifically.
