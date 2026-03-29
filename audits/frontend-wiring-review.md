# Frontend SDK Wiring Review

**Date:** 2026-03-25  
**Reviewer:** Kai (automated sub-agent)  
**Scope:** All frontend components wired to `@perk/sdk` — provider, hooks, trade panel, deposit/withdraw, create market, positions, trigger orders.

---

## Summary

Overall the wiring is **solid**. The SDK integration follows correct patterns: read-only client for unauthenticated data, signing client gated on wallet connection, proper BN scaling, position auto-initialization before writes, and cleanup on unmount. Found **2 Critical**, **3 High**, **5 Medium**, **3 Low**, and **4 Info** items.

---

## Findings

### F-01 · Critical — Entry price calculation in `usePosition.ts` is wrong

**File:** `perk/app/src/hooks/usePosition.ts`, `toFrontendPosition()`

```ts
const entryPrice = absBasis > 0 ? (quoteEntry / absBasis) * PRICE_SCALE / POS_SCALE : 0;
```

**Issue:** The on-chain `quoteEntryAmount` and `baseSize` are both already scaled by `POS_SCALE` (1e6). The correct formula for entry price (in human-readable terms) is:

```
entryPrice = (quoteEntryAmount / |baseSize|) * (PRICE_SCALE / POS_SCALE)
```

But the code is doing `(quoteEntry / absBasis) * PRICE_SCALE / POS_SCALE`. Since `quoteEntry` and `absBasis` are raw `.toNumber()` values (already scaled), dividing them cancels the scaling. Then multiplying by `PRICE_SCALE / POS_SCALE = 1e6 / 1e6 = 1` gives the right result… **only if both have the same scale**.

Actually, re-examining: `quoteEntryAmount` is scaled by PRICE_SCALE (1e6, it's a quote amount in price units), and `baseSize` is scaled by POS_SCALE (1e6). So `quoteEntry / absBasis` gives a raw ratio, and `* PRICE_SCALE / POS_SCALE = * 1` is a no-op. This happens to be correct **only because PRICE_SCALE == POS_SCALE**.

**However**, the real issue is that `quoteEntryAmount` on-chain is not simply `baseSize * entryPrice`. It follows vAMM swap math. The division gives an *average* entry price which is approximately correct for display.

**Revised severity:** The formula is fragile — it relies on PRICE_SCALE == POS_SCALE. If those ever diverge, this breaks silently. The math is approximately correct for now.

**Revised rating:** **Medium** (not Critical — works today but fragile)

---

### F-02 · Critical — `collateral / PRICE_SCALE` used for collateral display is wrong

**File:** `perk/app/src/hooks/usePosition.ts`, `toFrontendPosition()`

```ts
const collateral = pos.depositedCollateral.toNumber(); // raw lamports/token units
...
depositedCollateral: collateral / PRICE_SCALE,
```

**Issue:** `depositedCollateral` is stored on-chain in **raw token units** (lamports for SOL = 1e9, or token smallest units for SPL). Dividing by `PRICE_SCALE` (1e6) is incorrect — it should divide by `10^decimals` where decimals depends on the collateral mint (9 for SOL, 6 for USDC, etc.).

For SOL: `1 SOL = 1e9 lamports`. Dividing by 1e6 gives `1000` instead of `1.0`.  
For USDC (6 decimals): `1 USDC = 1e6`. Dividing by 1e6 gives `1.0` — correct by coincidence.

This affects:
- `depositedCollateral` display (1000x too large for SOL)
- `pnlPercent` calculation (uses `collateral / PRICE_SCALE`)  
- `leverage` calculation (uses `collateral / PRICE_SCALE`)
- `availableMargin` calculation

**Impact:** All collateral-derived values are wrong for non-6-decimal tokens (like SOL with 9 decimals).

---

### F-03 · High — DepositWithdraw vault balance scaling uses wrong divisor

**File:** `perk/app/src/components/DepositWithdraw.tsx`

```ts
const decimals = getDecimals(market.tokenMint);
const scale = Math.pow(10, decimals);
// ...
setVaultBalance(pos.depositedCollateral.toNumber() / scale);
```

**Issue:** This correctly uses the token decimals to scale vault balance. But note that `market.tokenMint` is the **traded asset**, while the vault holds the **collateral mint** (`market.collateralMint`). If collateralMint differs from tokenMint (which is possible — the protocol has separate `tokenMint` and `collateralMint`), the decimals lookup is wrong.

Currently the `getDecimals` function only checks for SOL, defaulting to 6 for everything else. If the collateral is SOL but the market token isn't, or vice versa, the scaling will be wrong.

**Fix:** Use `market.collateralMint` instead of `market.tokenMint` for decimal lookup in vault balance, and ideally fetch actual decimals from the mint account on-chain.

---

### F-04 · High — `usePosition.ts` PnL calculation doesn't use SDK's battle-tested math

**File:** `perk/app/src/hooks/usePosition.ts`, `toFrontendPosition()`

```ts
// Unrealized PnL (simplified): baseSize * (markPrice - entryPrice)
const pnl = baseSize * (markPrice - entryPrice);
```

**Issue:** The on-chain PnL model uses the K-diff mechanism with ADL coefficients (`effectivePositionQ`, `accountEquity`). The simplified `baseSize * (markPrice - entryPrice)` ignores:
- ADL A-coefficient scaling (`effectivePositionQ`)
- Funding payments (`lastCumulativeFunding` delta)
- Fee credits/debts (`feeCredits`)
- Warmup/reserved PnL
- The actual stored `pnl` field on the position account

The SDK exports `accountEquity()`, `effectivePositionQ()`, and the position already has a `pnl` field (i128). These should be used instead.

**Impact:** Displayed PnL can diverge significantly from actual on-chain PnL, especially after ADL events or funding accrual.

---

### F-05 · High — Positions page doesn't use `market` prop to resolve tokenMint for close

**File:** `perk/app/src/components/Positions.tsx`

The `handleClose` uses `market.tokenMint` from the `market` prop, which comes from `displayMarket` on the trade page. This only works because the trade page is market-specific. If positions from multiple markets were ever displayed (which `usePositions()` supports), closing would always close on the current page's market, not the position's actual market.

The position has `p.market` (the market address) but not the `tokenMint`. The SDK's `closePosition` needs `tokenMint`, not market address. There's no way to derive `tokenMint` from the market address client-side without an additional fetch.

**Current impact:** Low for the current single-market trade page UX. But the data model supports multi-market display, creating a latent bug.

**Rating:** **Medium** (works in current UX, latent bug)

---

### F-06 · Medium — `MOCK_TOKEN_LIST` still used in CreateMarketForm

**File:** `perk/app/src/components/CreateMarketForm.tsx`

```ts
import { MOCK_TOKEN_LIST } from "@/lib/mock-data";
```

The create market form still uses `MOCK_TOKEN_LIST` for the token search dropdown. This is arguably acceptable for MVP (it's a convenience list, not mock data per se), but it's a hardcoded list that won't reflect actual on-chain tokens.

**Impact:** Users can still paste any mint address, so functionality isn't blocked. The dropdown is just a convenience.

---

### F-07 · Medium — `page.tsx` (homepage) still uses `MOCK_MARKETS`

**File:** `perk/app/src/app/page.tsx`

```ts
import { MOCK_MARKETS } from "@/lib/mock-data";
```

The landing page still derives stats (totalVolume, totalOI, totalMarkets, totalTraders) from mock data, not from the real `useMarkets()` hook.

**Impact:** Homepage displays fake numbers, not real on-chain data.

---

### F-08 · Medium — `usePythCandles.ts` falls back to `MOCK_CANDLES`

**File:** `perk/app/src/hooks/usePythCandles.ts`

Falls back to mock candle data when Pyth data isn't available. This is reasonable for MVP but should be clearly indicated to users.

---

### F-09 · Medium — No confirmation dialog for cancel trigger order

**File:** `perk/app/src/components/TriggerOrders.tsx`

Unlike `Positions.tsx` which has `window.confirm()` before close, `TriggerOrders.tsx` cancels immediately on click without confirmation. While less destructive than closing a position, consistency is important.

---

### F-10 · Medium — `k` field stored as JS Number may overflow

**File:** `perk/app/src/hooks/useMarkets.ts`

```ts
k: m.k.toNumber(),
```

The on-chain `k` value is `u128` and can be extremely large (MIN_INITIAL_K is 1e18, and k can grow from there). `Number.MAX_SAFE_INTEGER` is ~9e15. For any market with `k >= 1e16`, `.toNumber()` loses precision.

**Impact:** The `k` field in the frontend `Market` type will have precision loss for most real markets. This field isn't currently used for any frontend calculations (mark price uses `calculateMarkPrice` from SDK which does BN math), so impact is display-only.

---

### F-11 · Low — Dummy wallet generates a new keypair on every connection change

**File:** `perk/app/src/providers/PerkProvider.tsx`

```ts
const readonlyClient = useMemo(() => {
  const dummyWallet = makeDummyWallet();
  // ...
}, [connection]);
```

The dummy wallet is recreated when `connection` changes. `Keypair.generate()` is synchronous and fast, but it's a minor inefficiency. Could be a module-level constant since it's never used for signing.

---

### F-12 · Low — `deposit` and `withdraw` SDK calls don't pass `fallbackOracle`

**File:** `perk/app/src/components/DepositWithdraw.tsx`

```ts
const sig = await client.deposit(tokenMint, oracle, amountBN);
```

The SDK's `deposit()` signature accepts an optional `fallbackOracle` parameter. The market may have a fallback oracle configured (`market.fallbackOracleAddress`). Not passing it means the SDK defaults to `SystemProgram.programId`, which is correct when no fallback is set, but will fail if the on-chain market requires a fallback oracle.

Same issue exists in `withdraw`, `openPosition` (TradePanel), and `closePosition` (Positions).

---

### F-13 · Low — `maxLeverage` slider range is 1-20 but SDK minimum is 2x

**File:** `perk/app/src/components/CreateMarketForm.tsx`

```ts
<input type="range" min={1} max={20} step={1} value={maxLeverage} .../>
```

The SDK's `MIN_LEVERAGE = 200` (2x with LEVERAGE_SCALE=100). Setting leverage to 1x via the slider would produce `maxLeverageScaled = 1 * 100 = 100`, which is below MIN_LEVERAGE and would be rejected on-chain.

---

### F-14 · Info — BN import consistency

BN is imported from `@coral-xyz/anchor` in components (TradePanel, DepositWithdraw, TriggerOrders, CreateMarketForm) and from `bn.js` in the SDK itself. Since `@coral-xyz/anchor` re-exports `bn.js`, these are the same class at runtime. No issue.

---

### F-15 · Info — `useMarkets` mark price uses SDK's `calculateMarkPrice`

Confirmed: the hook delegates to the SDK's `calculateMarkPrice()` which uses proper BN arithmetic with precision scaling. The mark price formula `quoteReserve * pegMultiplier / (baseReserve * PRICE_SCALE)` with 1e12 intermediate precision is correct.

---

### F-16 · Info — Provider wrapping order is correct

`layout.tsx` wraps: `ConnectionProvider` → `WalletProvider` → `WalletModalProvider` → `PerkProvider`. This is correct — PerkProvider depends on `useConnection()` and `useAnchorWallet()` from the wallet adapter providers above it.

---

### F-17 · Info — `usePositionsForMarket` filters by symbol string

```ts
positions: positions.filter((p) => p.marketSymbol === symbol),
```

This relies on the `TOKEN_SYMBOLS` lookup table in `usePosition.ts` matching the `TOKEN_META` in `useMarkets.ts`. Both tables are identical. Works but fragile — should be a shared constant. Low risk since they're controlled by the same codebase.

---

## Checklist Results

| Area | Status | Notes |
|------|--------|-------|
| Provider: read-only client | ✅ | Dummy wallet, never signs |
| Provider: signing client | ✅ | Uses AnchorWallet, null when disconnected |
| Provider: re-creates on wallet change | ✅ | useMemo deps include anchorWallet |
| Provider: no memory leaks | ✅ | No subscriptions/intervals in provider |
| useMarkets: fetchAllMarkets | ✅ | Correct SDK call |
| useMarkets: type mapping | ⚠️ | k field overflow (F-10) |
| useMarkets: mark price | ✅ | Uses SDK calculateMarkPrice |
| useMarkets: polling/cleanup | ✅ | 10s interval, clearInterval on unmount, mountedRef |
| useMarkets: error handling | ✅ | Sets error state, logs to console |
| usePosition: fetchAllPositions | ✅ | Correct SDK call with publicKey |
| usePosition: field mapping | ❌ | Collateral scaling wrong (F-02), PnL simplified (F-04) |
| usePosition: trigger orders | ✅ | Fetched per-position when openTriggerOrders > 0 |
| usePosition: clears on disconnect | ✅ | Sets empty arrays when !connected |
| usePosition: polling/cleanup | ✅ | 5s interval with cleanup |
| TradePanel: openPosition params | ✅ | BN scaling, side enum, leverage format all correct |
| TradePanel: placeTriggerOrder | ✅ | Params match SDK TriggerOrderParams |
| TradePanel: position init | ✅ | try/catch fetchPosition, init if missing |
| TradePanel: error handling | ✅ | Alert on error, loading state |
| TradePanel: size scaling | ✅ | `Math.floor(sizeNum * POS_SCALE)` |
| DepositWithdraw: balance fetching | ⚠️ | Uses tokenMint instead of collateralMint (F-03) |
| DepositWithdraw: SDK calls | ✅ | deposit/withdraw called correctly |
| DepositWithdraw: amount scaling | ✅ | Uses token decimals |
| DepositWithdraw: position init | ✅ | Init before deposit/withdraw |
| CreateMarketForm: params | ⚠️ | maxLeverage min=1 below SDK minimum (F-13) |
| CreateMarketForm: PerkOracle PDA | ✅ | Uses readonlyClient.getPerkOracleAddress |
| CreateMarketForm: fee display | ✅ | Shows "~1 SOL + rent" |
| CreateMarketForm: mint validation | ✅ | isValidPubkey check, custom mint resolution |
| CreateMarketForm: redirect | ✅ | router.push after success |
| Positions: closePosition | ✅ | Correct SDK call (tokenMint, oracle) |
| TriggerOrders: cancelTriggerOrder | ✅ | Correct SDK call (tokenMint, orderId as BN) |
| Positions: confirmation | ✅ | window.confirm before close |
| TriggerOrders: confirmation | ⚠️ | Missing (F-09) |
| Mock data removed | ⚠️ | Still in homepage, CreateMarketForm token list, candles (F-06/07/08) |
| BN import consistency | ✅ | Same underlying library (F-14) |
| PublicKey usage | ✅ | Correct throughout |
| Type mismatches | ⚠️ | Collateral scaling assumes PRICE_SCALE (F-02) |
| No stale imports | ✅ | All imports used |

---

## Priority Fix List

1. **F-02 (Critical):** Fix collateral scaling — use actual token decimals instead of PRICE_SCALE
2. **F-04 (High):** Use SDK math functions (`accountEquity`, `effectivePositionQ`) for PnL/leverage instead of simplified formula
3. **F-03 (High):** Use `collateralMint` not `tokenMint` for decimal lookup in DepositWithdraw vault balance
4. **F-07 (Medium):** Wire homepage to `useMarkets()` instead of MOCK_MARKETS
5. **F-13 (Low):** Set CreateMarketForm leverage slider min to 2
6. **F-12 (Low):** Pass fallback oracle from market data to SDK calls
