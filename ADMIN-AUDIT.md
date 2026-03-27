# Perk Admin Page — Security Red-Team Audit

**Date:** 2026-03-26  
**Scope:** `app/src/app/admin/page.tsx`, `PerkProvider.tsx`, `error-utils.ts`, `next.config.js`  
**Classification:** INTERNAL ONLY — DO NOT PUBLISH  

---

## Executive Summary

The admin page is **well-built for a DeFi admin dashboard**. The security posture is above average — CSP headers are tight, error sanitization is solid, input validation exists for key fields, and the on-chain program is the true authority (admin signer validated on-chain). Most "vulnerabilities" here are defense-in-depth concerns rather than exploitable bugs.

**Critical/High findings: 0**  
**Medium findings: 3**  
**Low findings: 5**  
**Info findings: 5**  

---

## Findings

### M-1: `unsafe-eval` in CSP script-src

**Severity:** MEDIUM  
**Component:** `next.config.js` CSP header  

**Description:**  
The CSP includes `script-src 'self' 'unsafe-eval' 'unsafe-inline'`. While `unsafe-inline` is often unavoidable in Next.js (inline scripts for hydration), `unsafe-eval` significantly weakens CSP by allowing `eval()`, `Function()`, `setTimeout(string)`, etc. This opens the door to XSS payloads that use eval-based execution.

**Attack Scenario:**  
If any XSS vector is found (even via a dependency), `unsafe-eval` allows arbitrary code execution that a stricter CSP would block.

**Recommended Fix:**  
```js
// Remove 'unsafe-eval' — test if the app works without it.
// Next.js dev mode needs it, but production usually doesn't.
"script-src 'self' 'unsafe-inline'",
// Better: use nonces with next.config.js experimental.scriptNonce
```
If a dependency requires `eval`, consider `'wasm-unsafe-eval'` instead (narrower scope).

---

### M-2: No Rate-Limiting on Admin Actions (Client-Side Double-Submit Incomplete)

**Severity:** MEDIUM  
**Component:** All action handlers (PauseToggle, WithdrawSol, TransferAdmin, etc.)

**Description:**  
The code uses a `submittingRef` + `useState(submitting)` pattern to prevent double-submit, which is good. However:

1. The `submittingRef` guard is bypassed if the user opens DevTools and calls the handler directly, bypassing React's render cycle.
2. There's no debounce/cooldown after a successful submission — a user could rapidly re-submit different values.
3. The `WithdrawSol` handler has a subtle bug: if `lamports.isZero()` returns early with a toast, it does NOT reset `submittingRef.current = false`, permanently locking the widget until page reload.

**Proof of Concept (bug #3):**  
1. Enter `0.000000000` in the withdraw field (passes `parseFloat > 0` check as it rounds)
2. Actually — this specific value would fail the `parsed <= 0` check. But entering a value like `0.0000000001` (sub-lamport) would create `lamports = BN(0)` via the string truncation, hit the `isZero()` branch, and lock the ref.

**Recommended Fix:**  
```tsx
// In WithdrawSol handleWithdraw, move the isZero check BEFORE setting submittingRef:
const [whole, frac = ''] = amount.split('.');
const padded = (frac + '000000000').slice(0, 9);
const lamports = new BN(whole + padded);
if (lamports.isZero()) {
  toast.error('Amount too small');
  return; // <-- This was already before submittingRef was set? 
}
// Actually, the bug is that submittingRef IS set before this check. Move it:
```

Wait — re-reading the code: `submittingRef.current = true` is set BEFORE the lamports check. The `return` inside the try block doesn't hit finally. **This is a confirmed deadlock bug.**

```tsx
// Fix: validate BEFORE acquiring the lock
const handleWithdraw = async () => {
  if (submittingRef.current) return;
  const parsed = parseFloat(amount);
  if (isNaN(parsed) || parsed <= 0) { toast.error('...'); return; }
  const [whole, frac = ''] = amount.split('.');
  const padded = (frac + '000000000').slice(0, 9);
  const lamports = new BN(whole + padded);
  if (lamports.isZero()) { toast.error('Amount too small'); return; }
  if (!confirm(`Withdraw ${amount} SOL?`)) return;
  // NOW acquire the lock
  submittingRef.current = true;
  setSubmitting(true);
  try { ... } finally { setSubmitting(false); submittingRef.current = false; }
};
```

---

### M-3: SOL Withdrawal Amount Parsing Allows Precision Overflow

**Severity:** MEDIUM  
**Component:** `WithdrawSol.handleWithdraw`

**Description:**  
The lamport conversion uses string manipulation: `(frac + '000000000').slice(0, 9)`. If a user enters a value like `1.1234567891111`, the fractional part `1234567891111` gets sliced to `123456789` — correct. But the `whole` part is extracted via `amount.split('.')` on a user-controlled string. Entering something like `1e18` would produce `whole = "1e18"`, `frac = ""`, resulting in `new BN("1e18000000000")` which BN.js would reject (non-numeric chars). This causes an uncaught exception inside the try block.

More subtly, negative numbers: entering `-1` → `whole = "-1"`, `frac = ""`, creating `new BN("-1000000000")`. The `parseFloat` check would catch `parsed <= 0`, but `parseFloat("-0.5")` returns `-0.5` which fails the check. So this is properly guarded. ✓

**But:** entering `999999999999` SOL (huge amount) — `parseFloat` accepts it, the BN is valid, and it goes to chain where it would fail. This is acceptable (chain rejects it), but the UX could be better.

**Recommended Fix:**  
Add an explicit regex validation before parsing:
```tsx
if (!/^\d+(\.\d{1,9})?$/.test(amount)) {
  toast.error('Invalid SOL amount format');
  return;
}
```

---

### L-1: Information Leakage — Admin Dashboard Code Shipped to All Users

**Severity:** LOW  
**Component:** `admin/page.tsx`

**Description:**  
The entire admin page component tree is in a single file. While the code comment mentions "tree-shaken from the initial page load," this is incorrect — there is no `dynamic()` import or code-splitting boundary. The `AdminDashboard` component and all children are statically imported and bundled into the admin page chunk. Any user navigating to `/admin` downloads the full admin UI JavaScript.

This exposes:
- `TOKEN_LIST` with all 20 hardcoded token mints
- `CRANKER_PUBKEY` (`99mUUwVBvCD1pLP7fk5z7xPuBoGpyuUGpyTBhW53yw99`)
- All admin action names and parameters
- The full structure of admin operations

**Impact:** Low — this is all public info (on-chain program is open), but it unnecessarily reveals admin operational details.

**Note:** There's a `dynamic` import at the top (`import dynamic from 'next/dynamic'`) that's **never used**. It appears the intent was to lazy-load AdminDashboard but it wasn't implemented.

**Recommended Fix:**  
```tsx
// At the top of the file, replace the static AdminDashboard with:
const AdminDashboard = dynamic(() => import('./AdminDashboard'), {
  loading: () => <div>Loading...</div>,
  ssr: false,
});
// Move AdminDashboard and all sub-components to AdminDashboard.tsx
```

---

### L-2: No Confirmation for Custom Mint Oracle Init

**Severity:** LOW  
**Component:** `InitPerkOracle.initSingle` (custom mint path)

**Description:**  
When clicking a TOKEN_LIST button, there's no confirmation dialog. When using the custom mint input, there's also no confirmation. The `batchInitAll` function properly confirms. A typo in the custom mint field would init an oracle for the wrong token (wasting SOL on rent, creating a useless account).

**Recommended Fix:**  
Add `confirm()` before `initSingle` for custom mints:
```tsx
<button onClick={() => {
  if (customMint && confirm(`Initialize oracle for mint ${truncatePubkey(customMint)}?`)) {
    initSingle(customMint);
  }
}}>
```

---

### L-3: Clipboard API Failure Handling

**Severity:** LOW  
**Component:** `InfoCell.handleCopy`

**Description:**  
The clipboard copy uses `navigator.clipboard.writeText()` which requires a secure context and user gesture. The fallback message "Copy failed — use Ctrl+C" is good. However, there's no protection against **clipboard injection** in the reverse direction — the `copyValue` is always a pubkey/address from on-chain state. Since these come from `PublicKey.toBase58()`, they are safe (base58 charset only). ✓

No actual vulnerability here — this is well-handled.

---

### L-4: Oracle Config Accepts Negative Integers

**Severity:** LOW  
**Component:** `UpdateOracleConfigPanel.handleUpdate`

**Description:**  
The validation checks `isNaN(val) || !Number.isInteger(val)` but does not check for negative values. `parseInt("-5", 10)` is a valid integer. Entering `-1` for `minSources` or `-100` for `maxStalenessSeconds` would be sent to the on-chain program.

**Impact:** The on-chain program likely validates these (Anchor constraints), so the TX would fail. But it creates a confusing UX.

**Recommended Fix:**  
```tsx
if (val !== null && (isNaN(val) || !Number.isInteger(val) || val < 0)) {
  toast.error(`${key} must be a non-negative integer`);
  return;
}
```

---

### L-5: `OracleSource` Select Casts Unvalidated Number

**Severity:** LOW  
**Component:** `SetFallbackOraclePanel`

**Description:**  
```tsx
onChange={(e) => setSource(Number(e.target.value) as OracleSource)}
```
The `<select>` only has three valid options, but if DOM is manipulated via DevTools, any number could be injected. `Number("999") as OracleSource` would create an invalid enum value sent to the program.

**Impact:** On-chain program would reject invalid oracle source. Defense-in-depth only.

**Recommended Fix:**  
```tsx
const val = Number(e.target.value);
if ([OracleSource.Pyth, OracleSource.PerkOracle, OracleSource.DexPool].includes(val)) {
  setSource(val as OracleSource);
}
```

---

### I-1: Error Sanitization Is Solid ✓

**Severity:** INFO (positive finding)

The `sanitizeError` function is well-implemented:
- Never exposes raw error messages to users
- Logs full errors only in development mode
- Production logs only context, no error details
- Generic fallback for unknown errors

No issues found.

---

### I-2: Clickjacking Protection Is Proper ✓

**Severity:** INFO (positive finding)

Both `frame-ancestors 'none'` (CSP) and `X-Frame-Options: DENY` are set. This prevents the admin page from being embedded in an iframe for clickjacking attacks. The belt-and-suspenders approach (both headers) is correct for browser compatibility.

---

### I-3: On-Chain Admin Validation Is the True Security Boundary ✓

**Severity:** INFO (architecture note)

The client-side admin check (`publicKey?.toBase58() !== onChainAdmin`) is a UX gate, not a security gate. The on-chain program validates the admin signer on every transaction. Even if someone bypasses the client-side check (trivial via DevTools), they cannot submit valid admin transactions without the admin wallet's private key.

**This is the correct architecture.** The client-side check prevents confusion; the on-chain check prevents exploitation.

---

### I-4: Transaction Manipulation via Wallet Adapter

**Severity:** INFO  

**Can someone intercept/modify the TX before signing?**

The transaction flow is: `PerkClient` builds TX → `sendTransaction` (from wallet adapter) → Phantom/wallet signs → submitted to RPC.

The signing happens inside the wallet (Phantom). A malicious browser extension could theoretically modify the TX before it reaches the wallet, but:
1. The wallet shows a simulation preview
2. The admin should verify the TX details in Phantom before signing
3. This is a universal risk for all web3 apps, not specific to this code

**Phishing vector:** An attacker could clone perk.fund/admin, replace the `PerkClient` with a malicious one that builds different transactions (e.g., `transferAdmin` to attacker). The admin's wallet would show the real TX for signing. **Mitigation:** Admin should always verify the URL and check TX simulation in Phantom.

No code fix possible — this is a user-education issue. Consider adding a domain verification banner or using Phantom's trusted app registry.

---

### I-5: HSTS and Security Headers Are Complete ✓

**Severity:** INFO (positive finding)

Full header audit:
- ✅ `Strict-Transport-Security: max-age=31536000; includeSubDomains`
- ✅ `X-Content-Type-Options: nosniff`
- ✅ `Referrer-Policy: strict-origin-when-cross-origin`
- ✅ `Permissions-Policy: camera=(), microphone=(), geolocation=()`
- ✅ `X-XSS-Protection: 0` (correct — disabling is recommended over `1; mode=block` per MDN)
- ✅ `X-Frame-Options: DENY`
- ✅ CSP with `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'self'`

---

## Batch PerkOracle Init Flow Review

### Can someone front-run the oracle init?

**Risk: LOW.** The `initializePerkOracle` instruction likely uses a PDA derived from the token mint, so only one oracle can exist per mint. If someone front-runs, the admin's TX would fail with "already in use" — annoying but not exploitable. The oracle would have been initialized with whatever params the front-runner chose, but since the admin can call `updateOracleConfig` afterward, this is recoverable.

**However:** If oracle init is admin-gated on-chain (requires admin signer), front-running is impossible. The code comment says "v2: permissionless oracle init" — if init is truly permissionless, an attacker could pre-initialize oracles with bad params (e.g., `minSources: 0`, `maxStalenessSeconds: 999999`). The admin would then need to call `updateOracleConfig` to fix params.

**Recommendation:** Verify the on-chain program enforces admin-only init, OR ensure `updateOracleConfig` is admin-gated so bad params can always be corrected.

### Are the default params safe?

| Param | Value | Assessment |
|---|---|---|
| `minSources` | 2 | ✅ Reasonable. Prevents single-source manipulation. |
| `maxStalenessSeconds` | 120 | ⚠️ 2 minutes is generous for a perps DEX. During high volatility, 2-minute-old prices enable oracle exploitation. Consider 30-60s. |
| `maxPriceChangeBps` | 0 | ⚠️ 0 = disabled. This means no circuit breaker on price jumps. A flash crash or oracle manipulation could propagate instantly. Consider setting a non-zero value (e.g., 1000 bps = 10%). |
| `circuitBreakerDeviationBps` | 0 | ⚠️ Same concern — disabled circuit breaker. |

**Recommendation:** Non-zero values for `maxPriceChangeBps` and `circuitBreakerDeviationBps` are strongly recommended for a perpetual futures protocol. A price oracle reporting a 50% move with no circuit breaker could cascade into mass liquidations or protocol insolvency.

### Sequential TX submission issues?

The `batchInitAll` loop submits transactions sequentially with `await` per iteration. Issues:

1. **User fatigue:** 20 sequential Phantom popups. The admin must approve each one. Risk of misclick (approving something else if a phishing popup appears).
2. **Partial failure:** If TX #8 fails, TXs 1-7 are already confirmed. The UI handles this correctly (tracks `existingOracles`, shows progress). ✓
3. **Nonce/blockhash:** Each TX gets a fresh blockhash. No issues with sequential submission. ✓
4. **No rollback:** If some inits succeed and others fail, the state is inconsistent. This is acceptable — the admin can retry failed ones individually. ✓

**Recommendation:** Consider batching multiple inits into a single transaction (if the on-chain program supports it) to reduce the number of approvals. If not possible, document the expected behavior clearly.

---

## Summary of Actionable Items

| ID | Severity | Fix Effort | Description |
|---|---|---|---|
| M-1 | MEDIUM | Low | Remove `unsafe-eval` from CSP |
| M-2 | MEDIUM | Low | Fix `submittingRef` deadlock in WithdrawSol |
| M-3 | MEDIUM | Low | Add regex validation for SOL amount format |
| L-1 | LOW | Medium | Code-split AdminDashboard (use the unused `dynamic` import) |
| L-2 | LOW | Trivial | Add confirm dialog for custom mint oracle init |
| L-4 | LOW | Trivial | Reject negative integers in oracle config |
| L-5 | LOW | Trivial | Validate OracleSource enum values |
| — | — | Low | Set non-zero `maxPriceChangeBps` and `circuitBreakerDeviationBps` |
| — | — | Low | Consider reducing `maxStalenessSeconds` to 30-60s |

---

*Audit by Kai — 2026-03-26. Internal use only.*
