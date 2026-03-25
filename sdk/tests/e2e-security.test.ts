/**
 * Perk Protocol — Security Feature E2E Tests (Solana Devnet)
 *
 * Tests the security hardening from 3 rounds of audits:
 * - Circuit breaker (EMA deviation rejection)
 * - Sliding window banding (cumulative move limit)
 * - Unfreeze anchoring (EMA + window set to pre-freeze price)
 * - Oracle config expansion (min_sources, max_staleness, circuit_breaker)
 * - Per-update banding (single large move rejection)
 *
 * Each test uses its own token mint to get a fresh PerkOracle PDA.
 *
 * Usage: npx ts-node tests/e2e-security.test.ts
 */

import {
  Connection,
  Keypair,
  PublicKey,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  createMint,
  mintTo,
  getOrCreateAssociatedTokenAccount,
} from "@solana/spl-token";
import { Wallet, BN } from "@coral-xyz/anchor";

import { PerkClient } from "../src/client";
import {
  OracleSource,
  InitPerkOracleParams,
  UpdatePerkOracleParams,
  UpdateOracleConfigParams,
} from "../src/types";
import { PRICE_SCALE } from "../src/constants";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const RPC_URL = "https://api.devnet.solana.com";
const TOKEN_DECIMALS = 6;
const DELAY_MS = 2000;
const CONFIDENCE = new BN(1_000);
const NUM_SOURCES = 3;

// ─────────────────────────────────────────────
// Real Token Price Profiles (for realistic oracle testing)
// Based on actual Solana memecoin data from 2026-03-25
// ─────────────────────────────────────────────
// $VNUT (The Vaping Squirrel) — $0.0004, -60% in 24h, extreme volatility
// $CAPTCHA (captcha.social) — $0.0044, +16900% in 24h, fresh rocket
// $APES (Apes Together Strong) — $0.0005, moderate volatility

// Price profiles in PRICE_SCALE (1e6)
const VNUT_PRICES = {
  initial: new BN(400),        // $0.0004
  crashed: new BN(160),        // $0.00016 (-60%)
  recovered: new BN(300),      // $0.0003 (partial recovery)
};
const CAPTCHA_PRICES = {
  initial: new BN(26),         // $0.000026 (pre-pump)
  pumped: new BN(4400),        // $0.0044 (+16900%)
  midPump: new BN(1000),       // $0.001 (mid-pump)
};
const APES_PRICES = {
  initial: new BN(500),        // $0.0005
  up: new BN(580),             // $0.00058 (+16%)
  dip: new BN(370),            // $0.00037 (-26%)
};

// ─────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────

function loadKeypair(name: string): Keypair {
  const filePath = path.join(__dirname, "wallets", `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeClient(connection: Connection, keypair: Keypair): PerkClient {
  const wallet = new Wallet(keypair);
  return new PerkClient({ connection, wallet, commitment: "confirmed" });
}

/** Create a fresh SPL mint so each test gets its own PerkOracle PDA. */
async function createFreshMint(
  connection: Connection,
  payer: Keypair,
): Promise<PublicKey> {
  const mint = await createMint(
    connection,
    payer,
    payer.publicKey,
    null,
    TOKEN_DECIMALS,
  );
  await sleep(1000);
  return mint;
}

let testsPassed = 0;
let testsFailed = 0;

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Perk Protocol — Security Feature E2E Tests");
  console.log("═══════════════════════════════════════════\n");

  const connection = new Connection(RPC_URL, "confirmed");

  // ── Load Wallets ──
  console.log("── 🔑 Load Wallets ──");
  const admin = loadKeypair("admin");
  const cranker = loadKeypair("cranker");
  const feeWallet = loadKeypair("feeWallet");

  const adminClient = makeClient(connection, admin);
  const crankerClient = makeClient(connection, cranker);

  console.log(`  admin:   ${admin.publicKey.toBase58()}`);
  console.log(`  cranker: ${cranker.publicKey.toBase58()}`);

  // Fund cranker if needed
  const crankerBal = await connection.getBalance(cranker.publicKey);
  if (crankerBal < 0.05 * LAMPORTS_PER_SOL) {
    console.log("  Funding cranker...");
    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: admin.publicKey,
        toPubkey: cranker.publicKey,
        lamports: 0.1 * LAMPORTS_PER_SOL,
      }),
    );
    await sendAndConfirmTransaction(connection, tx, [admin]);
    await sleep(1000);
  }

  // ── Ensure Protocol is Initialized ──
  console.log("\n── 🏛️ Ensure Protocol Initialized ──");
  {
    const feeAta = await getOrCreateAssociatedTokenAccount(
      connection,
      admin,
      // Use a dummy mint for protocol fee vault — we just need any valid ATA
      // The existing tests already created this, so fetch it from feeWallet
      await createMint(connection, admin, admin.publicKey, null, TOKEN_DECIMALS),
      feeWallet.publicKey,
    );
    try {
      await adminClient.initializeProtocol(feeAta.address);
      console.log("  ✅ Protocol initialized");
    } catch (err: any) {
      if (err.message?.includes("already in use")) {
        console.log("  ⚠️  Protocol already initialized. Continuing...");
      } else {
        throw err;
      }
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Test 1: Circuit Breaker Rejects Wild Price Jump
  // ═══════════════════════════════════════════
  console.log("\n══════════════════════════════════════════════════════════");
  console.log("  Test 1: Circuit Breaker Rejects Wild Price Jump");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    // Init oracle: circuit breaker at 10%, no banding
    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 0,
      circuitBreakerDeviationBps: 1000, // 10%
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (circuit breaker: 10%, banding: off)");
    await sleep(DELAY_MS);

    // Post initial price = 50_000 ($0.05)
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(50_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price posted: 50,000 ($0.05)");
    await sleep(DELAY_MS);

    // Try +20% jump → should fail
    console.log("  Attempting +20% jump (60,000)...");
    try {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(60_000),
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      throw new Error("Should have failed!");
    } catch (err: any) {
      if (err.message.includes("Should have failed")) {
        throw err;
      } else if (err.message.includes("OracleCircuitBreakerTripped")) {
        console.log("  ✅ Correctly rejected: circuit breaker tripped");
      } else {
        throw new Error(`Expected OracleCircuitBreakerTripped but got: ${err.message?.slice(0, 200)}`);
      }
    }
    await sleep(DELAY_MS);

    // Post +8% → should succeed (within 10% circuit breaker)
    console.log("  Attempting +8% (54,000)...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(54_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ +8% update accepted (within 10% circuit breaker)");

    // Verify
    const oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 54_000) {
      throw new Error(`Expected price 54000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 1 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 1 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 2: Circuit Breaker Allows When Disabled
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 2: Circuit Breaker Allows When Disabled");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 0,
      circuitBreakerDeviationBps: 0, // disabled
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (circuit breaker: disabled, banding: off)");
    await sleep(DELAY_MS);

    // Post initial price
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(50_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price posted: 50,000");
    await sleep(DELAY_MS);

    // Post +100% → should succeed with no protection
    console.log("  Attempting +100% jump (100,000)...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ +100% update accepted (no circuit breaker)");

    const oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 100_000) {
      throw new Error(`Expected price 100000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 2 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 2 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 3: Sliding Window Rejects Cumulative Walk
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 3: Sliding Window Rejects Cumulative Walk");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 500, // 5% per update
      circuitBreakerDeviationBps: 0, // disabled for isolation
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (banding: 5% per update, circuit breaker: off)");
    await sleep(DELAY_MS);

    // Post initial price
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price: 100,000");
    await sleep(DELAY_MS);

    // Walk up: each ~+5%
    const walkPrices = [105_000, 110_250, 115_762, 121_550];
    let hitCumulativeLimit = false;

    for (let i = 0; i < walkPrices.length; i++) {
      const price = walkPrices[i];
      console.log(`  Step ${i + 1}: posting ${price}...`);
      try {
        await crankerClient.updatePerkOracle(mint, {
          price: new BN(price),
          confidence: CONFIDENCE,
          numSources: NUM_SOURCES,
        });
        console.log(`    ✅ Accepted`);
        await sleep(DELAY_MS);
      } catch (err: any) {
        if (err.message.includes("OraclePriceInvalid")) {
          console.log(`    ✅ Correctly rejected at step ${i + 1}: cumulative window exceeded`);
          hitCumulativeLimit = true;
          break;
        } else {
          throw new Error(`Expected OraclePriceInvalid but got: ${err.message?.slice(0, 200)}`);
        }
      }
    }

    if (!hitCumulativeLimit) {
      throw new Error("All walk steps accepted — sliding window didn't trigger!");
    }
    console.log("  ✅ Test 3 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 3 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 4: Unfreeze Anchoring — EMA Preserved
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 4: Unfreeze Anchoring — EMA Preserved");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 3000, // 30% per update
      circuitBreakerDeviationBps: 1000, // 10% from EMA
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (banding: 30%, circuit breaker: 10%)");
    await sleep(DELAY_MS);

    // Post initial price + a few updates to establish EMA
    const basePrice = 100_000;
    console.log("  Establishing EMA with stable prices...");
    for (let i = 0; i < 3; i++) {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(basePrice + i * 100), // 100_000, 100_100, 100_200
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      console.log(`    Update ${i + 1}: ${basePrice + i * 100}`);
      await sleep(DELAY_MS);
    }

    // Freeze oracle
    console.log("  Freezing oracle...");
    await adminClient.freezePerkOracle(mint, true);
    await sleep(DELAY_MS);

    let oracle = await adminClient.fetchPerkOracle(mint);
    console.log(`  Frozen: ${oracle.isFrozen}, EMA: ${oracle.emaPrice.toNumber()}`);

    // Unfreeze oracle
    console.log("  Unfreezing oracle...");
    await adminClient.freezePerkOracle(mint, false);
    await sleep(DELAY_MS);

    oracle = await adminClient.fetchPerkOracle(mint);
    console.log(`  Unfrozen. EMA: ${oracle.emaPrice.toNumber()}`);

    // Try +30% from base (within per-update banding but exceeds 10% circuit breaker)
    console.log("  Attempting +30% (130,000) — should fail (exceeds 10% CB from EMA)...");
    try {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(130_000),
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      throw new Error("Should have failed!");
    } catch (err: any) {
      if (err.message.includes("Should have failed")) {
        throw err;
      } else if (err.message.includes("OracleCircuitBreakerTripped")) {
        console.log("  ✅ Correctly rejected: circuit breaker (EMA preserved after unfreeze)");
      } else {
        throw new Error(`Expected OracleCircuitBreakerTripped but got: ${err.message?.slice(0, 200)}`);
      }
    }
    await sleep(DELAY_MS);

    // Post +8% → within circuit breaker
    console.log("  Attempting +8% (108,000) — should succeed...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(108_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ +8% accepted (within 10% circuit breaker)");

    oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 108_000) {
      throw new Error(`Expected price 108000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 4 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 4 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 5: Oracle Config Update (All Fields)
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 5: Oracle Config Update (All Fields)");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 60,
      maxPriceChangeBps: 500,
      circuitBreakerDeviationBps: 1000,
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (minSources: 1, staleness: 60s, banding: 500, CB: 1000)");
    await sleep(DELAY_MS);

    // Post initial price so oracle has data
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    await sleep(DELAY_MS);

    // Freeze → update config → unfreeze
    console.log("  Freezing oracle...");
    await adminClient.freezePerkOracle(mint, true);
    await sleep(DELAY_MS);

    console.log("  Updating config: minSources → 3, circuitBreakerDeviationBps → 2000");
    const configParams: UpdateOracleConfigParams = {
      minSources: 3,
      maxStalenessSeconds: null,    // don't change
      maxPriceChangeBps: null,       // don't change
      circuitBreakerDeviationBps: 2000,
    };
    await adminClient.updateOracleConfig(mint, configParams);
    console.log("  ✅ Config updated");
    await sleep(DELAY_MS);

    console.log("  Unfreezing oracle...");
    await adminClient.freezePerkOracle(mint, false);
    await sleep(DELAY_MS);

    // Verify config
    const oracle = await adminClient.fetchPerkOracle(mint);
    console.log(`  minSources: ${oracle.minSources} (expected: 3)`);
    console.log(`  maxStalenessSeconds: ${oracle.maxStalenessSeconds} (expected: 60, unchanged)`);

    if (oracle.minSources !== 3) {
      throw new Error(`Expected minSources=3, got ${oracle.minSources}`);
    }
    if (oracle.maxStalenessSeconds !== 60) {
      throw new Error(`Expected maxStalenessSeconds=60, got ${oracle.maxStalenessSeconds}`);
    }

    // Try posting with numSources=2 → should fail (needs 3 now)
    console.log("  Attempting update with numSources=2 (min is 3)...");
    try {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(100_000),
        confidence: CONFIDENCE,
        numSources: 2,
      });
      throw new Error("Should have failed!");
    } catch (err: any) {
      if (err.message.includes("Should have failed")) {
        throw err;
      } else if (err.message.includes("OracleInsufficientSources")) {
        console.log("  ✅ Correctly rejected: insufficient sources");
      } else {
        throw new Error(`Expected OracleInsufficientSources but got: ${err.message?.slice(0, 200)}`);
      }
    }
    await sleep(DELAY_MS);

    // Post with numSources=3 → should succeed
    console.log("  Attempting update with numSources=3...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: 3,
    });
    console.log("  ✅ Update with 3 sources accepted");

    console.log("  ✅ Test 5 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 5 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 6: Per-Update Banding Rejects Single Large Move
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 6: Per-Update Banding Rejects Single Large Move");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 500, // 5%
      circuitBreakerDeviationBps: 0, // disabled
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (banding: 5%, circuit breaker: off)");
    await sleep(DELAY_MS);

    // Post initial price
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price: 100,000");
    await sleep(DELAY_MS);

    // Try +10% → should fail (exceeds 5% per-update banding)
    console.log("  Attempting +10% (110,000) — should fail...");
    try {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(110_000),
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      throw new Error("Should have failed!");
    } catch (err: any) {
      if (err.message.includes("Should have failed")) {
        throw err;
      } else if (err.message.includes("OraclePriceInvalid")) {
        console.log("  ✅ Correctly rejected: per-update banding");
      } else {
        throw new Error(`Expected OraclePriceInvalid but got: ${err.message?.slice(0, 200)}`);
      }
    }
    await sleep(DELAY_MS);

    // Post +4% → should succeed
    console.log("  Attempting +4% (104,000) — should succeed...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(104_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ +4% update accepted (within 5% band)");

    const oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 104_000) {
      throw new Error(`Expected price 104000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 6 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 6 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 7: Circuit Breaker Rejects Downward Price Jump
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 7: Circuit Breaker Rejects Downward Price Jump");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    // Init oracle: circuit breaker at 10%, no banding
    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 0,
      circuitBreakerDeviationBps: 1000, // 10%
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (circuit breaker: 10%, banding: off)");
    await sleep(DELAY_MS);

    // Post initial price = 100_000
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price posted: 100,000");
    await sleep(DELAY_MS);

    // Try -20% jump → should fail
    console.log("  Attempting -20% (80,000) — should fail...");
    try {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(80_000),
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      throw new Error("Should have failed!");
    } catch (err: any) {
      if (err.message.includes("Should have failed")) {
        throw err;
      } else if (err.message.includes("OracleCircuitBreakerTripped")) {
        console.log("  ✅ Correctly rejected: circuit breaker tripped (downward)");
      } else {
        throw new Error(`Expected OracleCircuitBreakerTripped but got: ${err.message?.slice(0, 200)}`);
      }
    }
    await sleep(DELAY_MS);

    // Post -8% → should succeed (within 10% circuit breaker)
    console.log("  Attempting -8% (92,000) — should succeed...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(92_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ -8% update accepted (within 10% circuit breaker)");

    const oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 92_000) {
      throw new Error(`Expected price 92000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 7 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 7 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 8: Per-Update Banding Rejects Downward Move
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 8: Per-Update Banding Rejects Downward Move");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 500, // 5%
      circuitBreakerDeviationBps: 0, // disabled
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (banding: 5%, circuit breaker: off)");
    await sleep(DELAY_MS);

    // Post initial price
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(100_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price: 100,000");
    await sleep(DELAY_MS);

    // Try -10% → should fail (exceeds 5% per-update banding)
    console.log("  Attempting -10% (90,000) — should fail...");
    try {
      await crankerClient.updatePerkOracle(mint, {
        price: new BN(90_000),
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      throw new Error("Should have failed!");
    } catch (err: any) {
      if (err.message.includes("Should have failed")) {
        throw err;
      } else if (err.message.includes("OraclePriceInvalid")) {
        console.log("  ✅ Correctly rejected: per-update banding (downward)");
      } else {
        throw new Error(`Expected OraclePriceInvalid but got: ${err.message?.slice(0, 200)}`);
      }
    }
    await sleep(DELAY_MS);

    // Post -4% → should succeed
    console.log("  Attempting -4% (96,000) — should succeed...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(96_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ -4% update accepted (within 5% band)");

    const oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 96_000) {
      throw new Error(`Expected price 96000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 8 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 8 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Test 9: Circuit Breaker Exact Boundary (+10% = 1000 bps)
  // ═══════════════════════════════════════════
  console.log("══════════════════════════════════════════════════════════");
  console.log("  Test 9: Circuit Breaker Exact Boundary (+10% = 1000 bps)");
  console.log("══════════════════════════════════════════════════════════");
  try {
    const mint = await createFreshMint(connection, admin);
    console.log(`  Mint: ${mint.toBase58()}`);

    const oracleParams: InitPerkOracleParams = {
      minSources: 1,
      maxStalenessSeconds: 120,
      maxPriceChangeBps: 0, // disabled
      circuitBreakerDeviationBps: 1000, // 10%
    };
    await adminClient.initializePerkOracle(mint, cranker.publicKey, oracleParams);
    console.log("  Oracle initialized (circuit breaker: 10%, banding: off)");
    await sleep(DELAY_MS);

    // Post initial price = 10_000_000 (nice round number for clean math)
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(10_000_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  Initial price posted: 10,000,000");
    await sleep(DELAY_MS);

    // Post exactly +10% (11_000_000) → should PASS (on-chain uses <=)
    console.log("  Attempting exactly +10% (11,000,000) — should pass (boundary <=)...");
    await crankerClient.updatePerkOracle(mint, {
      price: new BN(11_000_000),
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    });
    console.log("  ✅ Exactly +10% accepted (boundary condition passed)");

    const oracle = await crankerClient.fetchPerkOracle(mint);
    if (oracle.price.toNumber() !== 11_000_000) {
      throw new Error(`Expected price 11000000, got ${oracle.price.toNumber()}`);
    }
    console.log("  ✅ Test 9 PASSED\n");
    testsPassed++;
  } catch (err: any) {
    console.log(`  ❌ Test 9 FAILED: ${err.message}`);
    testsFailed++;
  }

  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  console.log("═══════════════════════════════════════════");
  console.log("  Security E2E Test Summary");
  console.log("═══════════════════════════════════════════");
  console.log(`  ✅ Passed: ${testsPassed}`);
  console.log(`  ❌ Failed: ${testsFailed}`);
  console.log(`  Total:    ${testsPassed + testsFailed}`);

  if (testsFailed > 0) {
    console.log("\n⚠️  Some tests failed — check output above.");
    process.exit(1);
  } else {
    console.log("\n🎉 All security E2E tests passed!");
  }
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────

main().catch((err) => {
  console.error("\n❌ Security E2E test suite failed:", err);
  process.exit(1);
});
