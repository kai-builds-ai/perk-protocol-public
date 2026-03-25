/**
 * Unit tests for Perk Protocol cranker — pure math and logic.
 * No network access, no Solana RPC required.
 *
 * Run: npx ts-node tests/unit.test.ts
 */

import assert from "assert";
import BN from "bn.js";

// ─── Direct imports (no heavy SDK deps) ───
import { safeScalePrice, aggregateSources, PriceSource } from "../feeds";
import { TxRateLimiter } from "../rate-limiter";

// ─── Constants from SDK (inlined to avoid transitive Anchor/Solana deps) ───
const PRICE_SCALE = 1_000_000;
const BPS_DENOMINATOR = 10_000;
const MAINTENANCE_MARGIN_BPS = 500; // 5%

// ─── Re-implement computeMarginRatio locally (mirrors loops/liquidation.ts) ───
// This avoids importing the file which pulls in @solana/web3.js, @perk/sdk etc.
function computeMarginRatio(
  depositedCollateral: BN,
  baseSize: BN,
  quoteEntryAmount: BN,
  oraclePrice: BN,
): number {
  if (baseSize.isZero()) return Infinity;

  const baseSizeAbs = baseSize.isNeg() ? baseSize.neg() : baseSize;
  const notional = baseSizeAbs.mul(oraclePrice).div(new BN(PRICE_SCALE));
  if (notional.isZero()) return Infinity;

  const currentValue = baseSizeAbs.mul(oraclePrice).div(new BN(PRICE_SCALE));
  const isLong = !baseSize.isNeg();
  let pnl: BN;
  if (isLong) {
    pnl = currentValue.sub(quoteEntryAmount);
  } else {
    pnl = quoteEntryAmount.sub(currentValue);
  }

  const equity = depositedCollateral.add(pnl);
  if (equity.isNeg()) return 0;

  const ratioScaled = equity.mul(new BN(BPS_DENOMINATOR)).div(notional);
  return ratioScaled.toNumber() / BPS_DENOMINATOR;
}

// ─── Re-implement isTriggered locally (mirrors loops/triggers.ts) ───
enum TriggerOrderType { Limit = 0, StopLoss = 1, TakeProfit = 2 }
enum Side { Long = 0, Short = 1 }

interface TriggerOrder {
  orderType: TriggerOrderType;
  side: Side;
  triggerPrice: BN;
}

function isTriggered(order: TriggerOrder, oraclePrice: BN): boolean {
  const tp = order.triggerPrice;
  switch (order.orderType) {
    case TriggerOrderType.StopLoss:
      return order.side === Side.Long ? oraclePrice.lte(tp) : oraclePrice.gte(tp);
    case TriggerOrderType.TakeProfit:
      return order.side === Side.Long ? oraclePrice.gte(tp) : oraclePrice.lte(tp);
    case TriggerOrderType.Limit:
      return order.side === Side.Long ? oraclePrice.lte(tp) : oraclePrice.gte(tp);
    default:
      return false;
  }
}

// ─── Test runner ───
let passed = 0;
let failed = 0;
const failures: string[] = [];

function test(name: string, fn: () => void): void {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (err: any) {
    failed++;
    const msg = err?.message ?? String(err);
    failures.push(`${name}: ${msg}`);
    console.log(`  ❌ ${name} — ${msg}`);
  }
}

function assertThrows(fn: () => void, msgMatch?: string): void {
  let threw = false;
  try {
    fn();
  } catch (err: any) {
    threw = true;
    if (msgMatch && !String(err?.message ?? err).includes(msgMatch)) {
      throw new Error(`Expected error containing "${msgMatch}", got: "${err?.message}"`);
    }
  }
  if (!threw) throw new Error("Expected function to throw but it did not");
}

function assertBnEq(actual: BN, expected: BN, label?: string): void {
  assert(actual.eq(expected), `${label ?? "BN"}: expected ${expected.toString()} got ${actual.toString()}`);
}

function assertClose(actual: number, expected: number, epsilon: number, label?: string): void {
  const diff = Math.abs(actual - expected);
  assert(diff <= epsilon, `${label ?? "number"}: expected ~${expected} got ${actual} (diff ${diff} > ε ${epsilon})`);
}

// ════════════════════════════════════════════
// 1. safeScalePrice
// ════════════════════════════════════════════
console.log("\n── safeScalePrice ──");

test("$1.00 → BN(1_000_000)", () => {
  assertBnEq(safeScalePrice(1.0), new BN(1_000_000));
});

test("$0.0004 (VNUT) → BN(400)", () => {
  assertBnEq(safeScalePrice(0.0004), new BN(400));
});

test("$0.0044 (CAPTCHA) → BN(4400)", () => {
  assertBnEq(safeScalePrice(0.0044), new BN(4400));
});

test("$50000 (BTC-like) → BN(50_000_000_000)", () => {
  assertBnEq(safeScalePrice(50000), new BN(50_000_000_000));
});

test("$0.0000004 → throws (rounds to 0)", () => {
  assertThrows(() => safeScalePrice(0.0000004), "too small");
});

test("-1 → throws", () => {
  assertThrows(() => safeScalePrice(-1));
});

test("NaN → throws", () => {
  assertThrows(() => safeScalePrice(NaN));
});

test("Infinity → throws", () => {
  assertThrows(() => safeScalePrice(Infinity));
});

test("0 → throws", () => {
  assertThrows(() => safeScalePrice(0));
});

// ════════════════════════════════════════════
// 2. computeMarginRatio
// ════════════════════════════════════════════
console.log("\n── computeMarginRatio ──");

test("Long, healthy: ratio ≈ 1.833", () => {
  const ratio = computeMarginRatio(
    new BN(1000),  // collateral
    new BN(100),   // baseSize (long)
    new BN(500),   // quoteEntry
    new BN(6_000_000), // oracle $6
  );
  // notional = 100 * 6_000_000 / 1_000_000 = 600
  // pnl = 600 - 500 = 100
  // equity = 1000 + 100 = 1100
  // ratio = 1100 / 600 ≈ 1.8333
  assertClose(ratio, 1.8333, 0.01, "margin ratio");
});

test("Long, underwater: ratio = 0", () => {
  const ratio = computeMarginRatio(
    new BN(50),
    new BN(1000),
    new BN(5_000_000),
    new BN(4_000_000),
  );
  // notional = 1000 * 4_000_000 / 1_000_000 = 4000
  // pnl = 4000 - 5_000_000 = -4_996_000 (deeply negative)
  // equity = 50 + (-4_996_000) = negative → 0
  assert.strictEqual(ratio, 0, "should be 0 (underwater)");
});

test("Short, profitable: ratio ≈ 2.2", () => {
  const ratio = computeMarginRatio(
    new BN(1000),
    new BN(-100),  // short
    new BN(600),   // quoteEntry
    new BN(5_000_000), // oracle $5
  );
  // notional = 100 * 5_000_000 / 1_000_000 = 500
  // pnl = 600 - 500 = 100
  // equity = 1000 + 100 = 1100
  // ratio = 1100 / 500 = 2.2
  assertClose(ratio, 2.2, 0.01, "margin ratio");
});

test("Zero position → Infinity", () => {
  const ratio = computeMarginRatio(
    new BN(1000),
    new BN(0),
    new BN(0),
    new BN(5_000_000),
  );
  assert.strictEqual(ratio, Infinity);
});

test("Exact maintenance margin (5%)", () => {
  // We want ratio = 0.05
  // ratio = equity / notional = 0.05
  // Set up: notional = 10000, equity = 500
  // baseSize=10000, oracle=$1 → notional = 10000*1_000_000/1_000_000 = 10000
  // Long: pnl = 10000 - quoteEntry. equity = collateral + pnl = 500
  // Let quoteEntry = 10000 (pnl = 0), collateral = 500
  const ratio = computeMarginRatio(
    new BN(500),
    new BN(10000),
    new BN(10000),
    new BN(1_000_000),
  );
  // notional = 10000, pnl = 0, equity = 500, ratio = 500/10000 = 0.05
  assertClose(ratio, 0.05, 0.001, "exact maintenance");
});

// ════════════════════════════════════════════
// 3. TxRateLimiter
// ════════════════════════════════════════════
console.log("\n── TxRateLimiter ──");

test("Fresh limiter with max=5: canSend() true 5 times, false on 6th", () => {
  const limiter = new TxRateLimiter(5);
  for (let i = 0; i < 5; i++) {
    assert(limiter.canSend(), `canSend() should be true on call ${i + 1}`);
    limiter.record();
  }
  assert(!limiter.canSend(), "canSend() should be false on 6th call");
});

test("After 60s, old entries expire", () => {
  const limiter = new TxRateLimiter(2);
  // Manually push old timestamps
  const now = Date.now();
  (limiter as any).timestamps = [now - 61_000, now - 61_000];
  // Old entries should be cleaned by canSend
  assert(limiter.canSend(), "should be true after old entries expire");
});

test("record() without canSend() still counts", () => {
  const limiter = new TxRateLimiter(2);
  limiter.record();
  limiter.record();
  // Now should be full
  assert(!limiter.canSend(), "should be false after 2 records without canSend");
});

test("remaining tracks available slots", () => {
  const limiter = new TxRateLimiter(3);
  assert.strictEqual(limiter.remaining, 3);
  limiter.record();
  assert.strictEqual(limiter.remaining, 2);
  limiter.record();
  limiter.record();
  assert.strictEqual(limiter.remaining, 0);
});

// ════════════════════════════════════════════
// 4. Config Validation (loadConfig via env)
// ════════════════════════════════════════════
console.log("\n── Config Validation ──");

// We import loadConfig — it reads process.env, so we manipulate env for each test.
// Import dynamically to avoid side effects at module load.
function withEnv(overrides: Record<string, string | undefined>, fn: () => void): void {
  const saved: Record<string, string | undefined> = {};
  for (const key of Object.keys(overrides)) {
    saved[key] = process.env[key];
    if (overrides[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = overrides[key];
    }
  }
  try {
    fn();
  } finally {
    for (const key of Object.keys(saved)) {
      if (saved[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved[key];
      }
    }
  }
}

// Base valid env
const validEnv: Record<string, string> = {
  PERK_RPC_URL: "https://api.mainnet-beta.solana.com",
  PERK_KEYPAIR_PATH: "/tmp/test-keypair.json",
};

// We need to require loadConfig fresh each time to avoid caching issues,
// but since it's a pure function reading env, just importing once is fine.
import { loadConfig } from "../config";

test("Valid config passes", () => {
  withEnv(validEnv, () => {
    const config = loadConfig();
    assert.strictEqual(config.rpcUrl, validEnv.PERK_RPC_URL);
    assert.strictEqual(config.keypairPath, validEnv.PERK_KEYPAIR_PATH);
  });
});

test("maxTxPerMinute=0 → throws", () => {
  assertThrows(() => {
    withEnv({ ...validEnv, PERK_MAX_TX_PER_MINUTE: "0" }, () => {
      loadConfig();
    });
  }, "maxTxPerMinute");
});

test("maxTxPerMinute=-1 → throws", () => {
  assertThrows(() => {
    withEnv({ ...validEnv, PERK_MAX_TX_PER_MINUTE: "-1" }, () => {
      loadConfig();
    });
  }, "maxTxPerMinute");
});

test("oracleIntervalMs=0 → throws", () => {
  assertThrows(() => {
    withEnv({ ...validEnv, PERK_ORACLE_INTERVAL_MS: "0" }, () => {
      loadConfig();
    });
  }, "oracleIntervalMs");
});

test("maxDivergencePct=NaN → throws", () => {
  assertThrows(() => {
    withEnv({ ...validEnv, PERK_MAX_DIVERGENCE_PCT: "banana" }, () => {
      loadConfig();
    });
  }, "maxDivergencePct");
});

test("maxDivergencePct=2.0 → throws (>1)", () => {
  assertThrows(() => {
    withEnv({ ...validEnv, PERK_MAX_DIVERGENCE_PCT: "2.0" }, () => {
      loadConfig();
    });
  }, "maxDivergencePct");
});

test("Missing PERK_RPC_URL → throws", () => {
  assertThrows(() => {
    withEnv({ PERK_RPC_URL: undefined, PERK_KEYPAIR_PATH: "/tmp/k.json" }, () => {
      loadConfig();
    });
  }, "PERK_RPC_URL");
});

test("Missing PERK_KEYPAIR_PATH → throws", () => {
  assertThrows(() => {
    withEnv({ PERK_RPC_URL: "https://rpc.example.com", PERK_KEYPAIR_PATH: undefined }, () => {
      loadConfig();
    });
  }, "PERK_KEYPAIR_PATH");
});

// ════════════════════════════════════════════
// 5. Price Aggregation (aggregateSources)
// ════════════════════════════════════════════
console.log("\n── aggregateSources ──");

function mkSource(name: string, price: number): PriceSource {
  return { name, price, timestamp: Date.now() };
}

test("2 close sources → average + confidence", () => {
  const result = aggregateSources(
    [mkSource("a", 1.00), mkSource("b", 1.02)],
    2, 0.05, "TEST",
  );
  assertClose(result.finalPriceUsd, 1.01, 0.001, "avg price");
  assertClose(result.confidenceUsd, 0.02, 0.001, "confidence");
  assert.strictEqual(result.validSources.length, 2);
});

test("2 sources, >5% divergence → throws", () => {
  assertThrows(() => {
    aggregateSources(
      [mkSource("a", 1.00), mkSource("b", 1.10)],
      2, 0.05, "TEST",
    );
  }, "diverge");
});

test("1 source when minSources=2 → throws", () => {
  assertThrows(() => {
    aggregateSources([mkSource("a", 1.00)], 2, 0.05, "TEST");
  }, "Need at least 2");
});

test("0 sources → throws", () => {
  assertThrows(() => {
    aggregateSources([], 1, 0.05, "TEST");
  }, "No price sources");
});

test("Sources with negative price → filtered out", () => {
  // One negative, one valid — but minSources=2 → should throw (only 1 valid)
  assertThrows(() => {
    aggregateSources(
      [mkSource("bad", -5), mkSource("good", 1.00)],
      2, 0.05, "TEST",
    );
  }, "Need at least 2");
});

test("Sources with negative price → filtered, 1 source enough if minSources=1", () => {
  const result = aggregateSources(
    [mkSource("bad", -5), mkSource("good", 1.00)],
    1, 0.05, "TEST",
  );
  assertClose(result.finalPriceUsd, 1.00, 0.001, "price");
  assert.strictEqual(result.validSources.length, 1);
});

// ════════════════════════════════════════════
// 6. Trigger Conditions (isTriggered)
// ════════════════════════════════════════════
console.log("\n── isTriggered ──");

const TP = (n: number) => new BN(n);

test("StopLoss Long: triggers when oracle <= triggerPrice", () => {
  const order: TriggerOrder = { orderType: TriggerOrderType.StopLoss, side: Side.Long, triggerPrice: TP(100) };
  assert(isTriggered(order, TP(99)), "below → triggers");
  assert(isTriggered(order, TP(100)), "equal → triggers");
  assert(!isTriggered(order, TP(101)), "above → no trigger");
});

test("StopLoss Short: triggers when oracle >= triggerPrice", () => {
  const order: TriggerOrder = { orderType: TriggerOrderType.StopLoss, side: Side.Short, triggerPrice: TP(100) };
  assert(isTriggered(order, TP(101)), "above → triggers");
  assert(isTriggered(order, TP(100)), "equal → triggers");
  assert(!isTriggered(order, TP(99)), "below → no trigger");
});

test("TakeProfit Long: triggers when oracle >= triggerPrice", () => {
  const order: TriggerOrder = { orderType: TriggerOrderType.TakeProfit, side: Side.Long, triggerPrice: TP(100) };
  assert(isTriggered(order, TP(101)), "above → triggers");
  assert(isTriggered(order, TP(100)), "equal → triggers");
  assert(!isTriggered(order, TP(99)), "below → no trigger");
});

test("TakeProfit Short: triggers when oracle <= triggerPrice", () => {
  const order: TriggerOrder = { orderType: TriggerOrderType.TakeProfit, side: Side.Short, triggerPrice: TP(100) };
  assert(isTriggered(order, TP(99)), "below → triggers");
  assert(isTriggered(order, TP(100)), "equal → triggers");
  assert(!isTriggered(order, TP(101)), "above → no trigger");
});

test("Limit Long: triggers when oracle <= triggerPrice", () => {
  const order: TriggerOrder = { orderType: TriggerOrderType.Limit, side: Side.Long, triggerPrice: TP(100) };
  assert(isTriggered(order, TP(99)), "below → triggers");
  assert(isTriggered(order, TP(100)), "equal → triggers");
  assert(!isTriggered(order, TP(101)), "above → no trigger");
});

test("Limit Short: triggers when oracle >= triggerPrice", () => {
  const order: TriggerOrder = { orderType: TriggerOrderType.Limit, side: Side.Short, triggerPrice: TP(100) };
  assert(isTriggered(order, TP(101)), "above → triggers");
  assert(isTriggered(order, TP(100)), "equal → triggers");
  assert(!isTriggered(order, TP(99)), "below → no trigger");
});

test("Boundary: exactly at trigger price → triggers for all types", () => {
  for (const orderType of [TriggerOrderType.StopLoss, TriggerOrderType.TakeProfit, TriggerOrderType.Limit]) {
    for (const side of [Side.Long, Side.Short]) {
      const order: TriggerOrder = { orderType, side, triggerPrice: TP(500) };
      assert(isTriggered(order, TP(500)), `type=${orderType} side=${side} at boundary should trigger`);
    }
  }
});

test("Just above/below → doesn't trigger (direction-specific)", () => {
  // StopLoss Long needs oracle <= trigger. oracle=101, trigger=100 → should NOT trigger
  assert(!isTriggered(
    { orderType: TriggerOrderType.StopLoss, side: Side.Long, triggerPrice: TP(100) },
    TP(101),
  ), "SL Long: above should not trigger");

  // TakeProfit Long needs oracle >= trigger. oracle=99, trigger=100 → should NOT trigger
  assert(!isTriggered(
    { orderType: TriggerOrderType.TakeProfit, side: Side.Long, triggerPrice: TP(100) },
    TP(99),
  ), "TP Long: below should not trigger");
});

// ════════════════════════════════════════════
// Summary
// ════════════════════════════════════════════
console.log(`\n${"═".repeat(40)}`);
console.log(`Results: ${passed} passed, ${failed} failed`);
if (failures.length > 0) {
  console.log("\nFailures:");
  for (const f of failures) console.log(`  • ${f}`);
  process.exit(1);
} else {
  console.log("All tests passed! 🎉");
  process.exit(0);
}
