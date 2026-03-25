# Frontend SDK Wiring — Red Team Audit

**Date:** 2025-03-25  
**Auditor:** Kai (automated red team)  
**Scope:** Frontend ↔ SDK integration layer  
**Files reviewed:** PerkProvider, useMarkets, usePosition, TradePanel, DepositWithdraw, CreateMarketForm, Positions, TriggerOrders, types/index.ts, trade/[token]/page.tsx, SDK client.ts, types.ts, constants.ts, math.ts

---

## Summary

| Severity | Count |
|----------|-------|
| Critical | 3     |
| High     | 5     |
| Medium   | 5     |
| Low      | 4     |
| Info     | 4     |

---

## Critical Findings

### C-01: `k`, `baseReserve`, `quoteReserve` overflow `Number.MAX_SAFE_INTEGER`

**File:** `useMarkets.ts` → `toFrontendMarket()`  
**Lines:** `baseReserve: m.baseReserve.toNumber()`, `quoteReserve: m.quoteReserve.toNumber()`, `k: m.k.toNumber()`

On-chain these are u128 values. The SDK constant `MIN_INITIAL_K = 1e18`. JavaScript `Number.MAX_SAFE_INTEGER ≈ 9.007e15`. **Every single market has K ≥ 1e18, which is ~111x beyond safe integer range.** `.toNumber()` will silently produce incorrect values.

`baseReserve` and `quoteReserve` are also u128 and will overflow for any market with meaningful liquidity. Since these overflow values are stored in the frontend `Market` type and could be used for downstream calculations, this produces **silently wrong data**.

The `calculateMarkPrice()` in `math.ts` correctly uses BN arithmetic and only converts to Number at the final ratio step (safe). But the frontend stores the raw BN → Number conversion in the Market type, which is broken.

**Impact:** Silent data corruption for all markets. The stored `baseReserve`, `quoteReserve`, and `k` values in the frontend `Market` interface are garbage for any real market.

**Fix:** Either (a) don't store these as `number` — use `string` or `BN`, or (b) store them as scaled-down human-readable values with explicit documentation, or (c) remove them from the frontend type entirely if only used for display (mark price is already computed correctly via SDK math).

---

### C-02: Collateral scaling uses `PRICE_SCALE` instead of token decimals

**File:** `usePosition.ts` → `toFrontendPosition()`  
**Lines:** `collateral / PRICE_SCALE` (used in `depositedCollateral`, `pnlPercent`, `leverage`, `availableMargin`)

`depositedCollateral` on-chain is stored in **base token units** (e.g., lamports for SOL). The code divides by `PRICE_SCALE (1e6)` to convert to "human-readable". This is **only correct for tokens with 6 decimals** (USDC, most PF tokens).

For SOL (9 decimals): 1 SOL = 1e9 lamports. `1e9 / 1e6 = 1000`. The UI would show **1000 SOL** instead of **1 SOL**.

This cascades into every derived field:
- `depositedCollateral` → 1000x too high for SOL
- `leverage = notional / (collateral / PRICE_SCALE)` → 1000x too low for SOL
- `pnlPercent` → 1000x too low for SOL
- `availableMargin` → 1000x too high for SOL

**Impact:** All position display data is wrong for SOL markets. Leverage shows 0.005x instead of 5x. Collateral shows 1000 SOL instead of 1 SOL. PnL% is 1000x too small.

**Fix:** `usePosition.ts` needs the token decimals for each market's collateral mint. Pass decimals from market metadata or fetch from on-chain mint account. Use `10^decimals` instead of `PRICE_SCALE` for collateral scaling.

---

### C-03: SOL deposits will fail — native SOL vs Wrapped SOL mismatch

**File:** `DepositWithdraw.tsx`  
**Lines:** Balance display uses `connection.getBalance()` (native SOL), but SDK `deposit()` uses `getAssociatedTokenAddress(tokenMint, ...)` (WSOL ATA).

For SOL markets:
1. UI shows user's **native SOL balance** (e.g., 5.0 SOL)
2. User enters "1" and clicks Deposit
3. SDK calls `deposit()` which derives the **Wrapped SOL ATA** and tries to transfer from it
4. User's WSOL ATA is likely **empty** (most users hold native SOL, not WSOL)
5. Transaction fails with a confusing "insufficient balance" or "account not found" error

The user sees they have 5 SOL, tries to deposit 1, and gets an error. There's no wrapping step.

**Impact:** SOL deposits are completely broken. Users cannot deposit into SOL-margined markets.

**Fix:** Either (a) add SOL wrapping instructions before deposit (create WSOL ATA + transfer native SOL + sync), or (b) use a separate deposit flow for native SOL that the SDK handles, or (c) display WSOL ATA balance instead of native SOL (but this is poor UX).

---

## High Findings

### H-01: Position initialization race condition — double-init error

**Files:** `TradePanel.tsx`, `DepositWithdraw.tsx`  
**Pattern:** Both do `try { fetchPosition } catch { initializePosition }` independently.

If user clicks "Open Position" and "Deposit" in quick succession (or if auto-polling triggers alongside a manual action):

1. Both components call `fetchPosition()` → both get "not found"
2. Both call `initializePosition()`
3. First TX succeeds
4. Second TX fails with "account already initialized" (Anchor error)
5. User sees a confusing error on one of the two actions

This is worse than just a UX issue — the failed transaction still costs a network fee (the TX is submitted and rejected on-chain).

**Impact:** Confusing errors, wasted transaction fees. Intermittent but reproducible on first interaction with a market.

**Fix:** (a) Add a mutex/lock so only one init can run at a time, or (b) catch the "already initialized" error and retry the original operation, or (c) move position initialization to a single entry point (e.g., PerkProvider) that guarantees at-most-once.

---

### H-02: Entry price calculation may be incorrect

**File:** `usePosition.ts` → `toFrontendPosition()`  
**Code:**
```ts
const entryPrice = absBasis > 0 
  ? (quoteEntry / absBasis) * PRICE_SCALE / POS_SCALE 
  : 0;
```

Since `PRICE_SCALE === POS_SCALE === 1e6`, this simplifies to `quoteEntry / absBasis`. But the correctness depends on the on-chain units of `quoteEntryAmount` vs `baseSize`:

- If `quoteEntryAmount` is stored as `baseSize * entryPrice / PRICE_SCALE` (the most common pattern), then: `entryPrice = quoteEntryAmount * PRICE_SCALE / baseSize`. The current formula is missing a factor of `PRICE_SCALE` (1e6), making entry prices **1,000,000x too small**.
- If `quoteEntryAmount` stores the raw quote delta without PRICE_SCALE division, then: `entryPrice = quoteEntryAmount / baseSize`, which is what the code computes — but the result is in PRICE_SCALE units, and no conversion to human-readable is done.

Either way, the entry price is likely wrong. The SDK's own `math.ts` doesn't have an `entryPrice` helper, which suggests this is a custom frontend calculation that wasn't validated against on-chain behavior.

Meanwhile, the PnL calculation `pnl = baseSize * (markPrice - entryPrice)` compounds this error — if entryPrice is wrong, PnL is wrong too.

**Impact:** Entry price and PnL displayed to users may be incorrect by orders of magnitude.

**Fix:** Verify the on-chain units of `quoteEntryAmount` by reading the Rust code. Add an explicit `calculateEntryPrice()` function to `math.ts` in the SDK so frontend doesn't have to guess.

---

### H-03: No validation on size, leverage, or balance before TX submission

**File:** `TradePanel.tsx` → `handleSubmit()`

Missing validations:
- **Size = 0**: `sizeNum` check is `if (!sizeNum) return` which catches 0 and NaN, but not negative values (user can type "-5" in the input)
- **Size > maxPositionSize**: No check against `market.maxPositionSize` (not even in the frontend Market type)
- **Leverage > maxLeverage**: Slider limits this, but there's no explicit guard in `handleSubmit()`
- **Insufficient collateral**: No check that user has deposited enough collateral for the position
- **Market inactive**: No check for `market.active === false`

**File:** `DepositWithdraw.tsx` → `handleSubmit()`
- **Deposit > wallet balance**: No check
- **Withdraw > vault balance**: No check  
- **Negative amount**: `amountNum <= 0` catches negatives ✓

All of these will result in on-chain rejections with cryptic Anchor error codes instead of clean UI messages.

**Impact:** Poor UX. Users see raw Anchor error numbers instead of "Insufficient balance" or "Exceeds max position size".

**Fix:** Add client-side validation for all these cases with user-friendly error messages. Add `maxPositionSize` and `maxOi` to the frontend `Market` type.

---

### H-04: `useMarket()` creates redundant polling instances

**File:** `useMarkets.ts` → `useMarket()`

`useMarket(symbol)` calls `useMarkets()` internally, which creates its own `useState`, `useEffect`, and polling interval. Every component that calls `useMarket()` or `useMarkets()` creates an independent 10-second polling loop fetching **all markets** via `fetchAllMarkets()`.

In the trade page, `useMarket(token)` creates one instance. If other pages or components also call `useMarket`, each gets its own loop. With 50 markets on-chain, each poll fetches all 50 market accounts — that's 50 RPC `account.all()` calls per 10 seconds per component.

**Impact:** Excessive RPC calls. If user has 3 tabs open, that's 3 independent polling loops. Could hit RPC rate limits.

**Fix:** Move market fetching to a React context (similar to PerkProvider) that polls once and distributes to all consumers. Or use a shared SWR/React Query cache.

---

### H-05: `pegMultiplier` stored as `.toNumber()` — potential overflow

**File:** `useMarkets.ts` → `toFrontendMarket()`  
**Line:** `pegMultiplier: m.pegMultiplier.toNumber()`

`pegMultiplier` is a BN (u128 on-chain). While typically close to `PRICE_SCALE (1e6)`, it can diverge significantly for volatile markets where the peg has been updated many times. If it exceeds `2^53`, `.toNumber()` silently corrupts.

**Impact:** Silent data corruption for markets with extreme peg divergence.

**Fix:** Same as C-01 — either don't store in frontend, use string, or document safe range.

---

## Medium Findings

### M-01: Wallet disconnect during transaction — no cleanup

**Files:** `TradePanel.tsx`, `DepositWithdraw.tsx`, `Positions.tsx`, `TriggerOrders.tsx`

If the user disconnects their wallet while a transaction is in-flight (`isSubmitting = true`):
- The `client` object becomes null (PerkProvider recreates it without wallet)
- The in-flight transaction may still resolve or reject
- State updates (`setIsSubmitting(false)`) fire after wallet context has changed
- If the component re-renders with `client = null`, the error alert may not display correctly

No TX cancellation mechanism exists. Anchor transactions are fire-and-forget once submitted to RPC.

**Impact:** Confusing UX — user disconnects wallet, button stays in "Submitting..." state or shows a stale error.

**Fix:** Track wallet publicKey at TX submission time. On completion, verify wallet hasn't changed before showing success. Consider adding a "pending transactions" state that persists across wallet changes.

---

### M-02: `useEffect` dependency array issue in `usePositions`

**File:** `usePosition.ts`

The `fetchPositions` callback depends on `client`, `readonlyClient`, `publicKey`, and `connected`. But inside `fetchPositions`, it does a waterfall of async calls: for each position, it fetches the market, then trigger orders. If `client` changes mid-waterfall (e.g., wallet reconnect), the closure captures the stale client.

The `mountedRef` check prevents state updates after unmount, but doesn't prevent using a stale client for subsequent RPC calls within the same `fetchPositions` invocation.

**Impact:** Stale data possible during wallet switches. Low probability but could show another user's positions briefly.

**Fix:** Pass `perkClient` as a parameter snapshot rather than reading from closure, or abort the waterfall if client changes.

---

### M-03: CreateMarketForm uses `MOCK_TOKEN_LIST` — hardcoded token list

**File:** `CreateMarketForm.tsx`  
**Line:** `import { MOCK_TOKEN_LIST } from "@/lib/mock-data"`

The token dropdown is populated from mock data. While custom mint addresses can be pasted, the "popular tokens" list is static. This isn't a functional bug but:
- New tokens won't appear
- Delisted tokens remain
- Liquidity values shown are fake/stale

**Impact:** Misleading data for market creators. They might choose a token based on fake liquidity numbers from mock data.

**Fix:** Fetch token list from Jupiter token registry API or on-chain metadata. At minimum, rename `MOCK_TOKEN_LIST` and remove fake `liquidity` values, or mark them as "estimated".

---

### M-04: Slippage estimate in TradePanel is hardcoded, not from vAMM

**File:** `TradePanel.tsx` → `estimates`  
**Line:** `const slippage = sizeNum * 0.0008;`

The slippage estimate is `size * 0.0008` — a fixed constant unrelated to actual market depth. For a thin market, real slippage could be 10-100x higher. For a deep market, it could be much lower.

The SDK has `estimateExecutionPrice()` in `math.ts` which computes actual vAMM slippage from the constant product formula. This should be used instead.

**Impact:** Users see misleading slippage estimates. They may enter trades expecting 0.08% slippage but experience 5%+.

**Fix:** Use `estimateExecutionPrice(market, side, baseSize)` from SDK and calculate actual slippage vs mark price.

---

### M-05: `quoteEntryAmount` display in `UserPosition` uses wrong scale

**File:** `usePosition.ts`  
**Line:** `quoteEntryAmount: quoteEntry / PRICE_SCALE`

Same issue as C-02 — `quoteEntryAmount` on-chain is a BN whose units depend on the protocol's internal accounting. Dividing by `PRICE_SCALE` is an assumption. This value is exposed in the `UserPosition` type and could be used by other components.

**Impact:** Incorrect quoteEntryAmount display. Lower severity since it's not prominently shown in current UI.

**Fix:** Verify on-chain units. If quoteEntryAmount is in raw vAMM quote units, the conversion factor may differ.

---

## Low Findings

### L-01: DepositWithdraw button UX — double-click required

**File:** `DepositWithdraw.tsx`

The deposit/withdraw buttons combine mode selection with submission:
```ts
onClick={() => {
  setMode("deposit");
  if (mode === "deposit" && amount) handleSubmit();
}}
```

First click: sets mode. Second click: submits. Users expect a single click to deposit.

**Impact:** Confusing but not broken. Users will figure it out.

**Fix:** Separate mode selection from submission. Use a toggle for mode, single submit button.

---

### L-02: No loading state while position is being initialized

**Files:** `TradePanel.tsx`, `DepositWithdraw.tsx`

Position initialization (`initializePosition`) happens silently inside the submit handler. On devnet or during congestion, this TX can take 5-30 seconds. The user sees "Submitting..." but doesn't know a separate init TX is in progress.

**Impact:** User might think the app is frozen during first trade on a new market.

**Fix:** Show a two-step progress: "Initializing position... (1/2)" → "Opening position... (2/2)".

---

### L-03: Positions table uses array index as React key

**File:** `Positions.tsx`  
**Line:** `<tr key={i}>`

Using array index as key means React won't correctly reconcile rows if positions are reordered or one is removed. This can cause stale UI states (wrong position shows "closing" spinner).

**Impact:** Visual glitch if positions list changes while closing.

**Fix:** Use `p.market` or `p.authority + p.market` as key.

---

### L-04: Keyboard shortcuts conflict with browser defaults

**File:** `TradePanel.tsx`  
**Lines:** `if (e.key === "b"...) setSide(Long); if (e.key === "s"...) setSide(Short);`

The 'S' shortcut conflicts with browser "Find in page" (Ctrl+S = save, plain 'S' in some browser extensions). The handler checks `instanceof HTMLInputElement/HTMLTextAreaElement` but not `contentEditable` elements or other custom inputs.

**Impact:** Minor — unexpected side switches when typing in unfocused inputs.

**Fix:** Add modifier key requirement (e.g., Alt+B, Alt+S) or limit to when trade panel is focused.

---

## Info Findings

### I-01: Token metadata is duplicated across files

`TOKEN_META` in `useMarkets.ts` and `TOKEN_SYMBOLS` in `usePosition.ts` are separate hardcoded maps with the same data. Any update to one requires updating the other.

**Fix:** Extract to a shared `token-metadata.ts` module.

---

### I-02: `readonlyClient` generates a new Keypair on every connection change

**File:** `PerkProvider.tsx` → `makeDummyWallet()`

Each `useMemo` re-run creates a `Keypair.generate()`. This is a crypto operation (~0.1ms) and allocates memory for keys that are never used. Harmless but wasteful.

**Fix:** Use a constant dummy keypair (e.g., `Keypair.fromSeed(new Uint8Array(32))`) or memoize more aggressively.

---

### I-03: `alerts()` used for transaction confirmations

All submit handlers use `alert()` for success/failure. This blocks the main thread and is not dismissible on mobile browsers. It also prevents the UI from updating (e.g., position list refresh) until the user clicks OK.

**Fix:** Use toast notifications (e.g., react-hot-toast, sonner) that auto-dismiss.

---

### I-04: `active` field typed as `bool` alias in types/index.ts

**File:** `types/index.ts`  
**Line:** `active: bool;` with `type bool = boolean;`

Harmless but unconventional. The `bool` alias adds confusion without value.

**Fix:** Use `boolean` directly.

---

## Attack Path Summary

A motivated attacker could exploit these bugs as follows:

1. **C-03 (SOL deposits broken):** Users physically cannot use SOL-margined markets. This blocks core protocol functionality.

2. **C-02 + H-02 (Wrong collateral/entry price scaling):** User sees wildly wrong position data. They might close a profitable position thinking it's losing, or hold a losing position thinking it's profitable. In a leveraged trading protocol, this directly causes user fund losses.

3. **C-01 (K overflow):** While `calculateMarkPrice` in SDK math correctly uses BN, the frontend `Market` type stores corrupted `k`, `baseReserve`, `quoteReserve` values. Any future component using these (e.g., depth chart, slippage calculator, liquidity display) will produce garbage.

4. **H-01 (Position init race):** An attacker could craft a UI flow that triggers simultaneous init attempts, causing one operation to fail and leaving the user in an inconsistent state.

5. **M-04 (Fake slippage):** Users see 0.08% estimated slippage on a thin market. They submit a 10x leveraged trade. Actual slippage is 5%. They're underwater immediately.
