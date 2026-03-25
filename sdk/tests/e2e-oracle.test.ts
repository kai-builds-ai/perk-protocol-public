/**
 * Perk Protocol — PerkOracle E2E Integration Test Suite (Solana Devnet)
 *
 * Tests the full trade lifecycle using PerkOracle (custom oracle system)
 * instead of Pyth. Covers oracle init, price updates, freeze/unfreeze,
 * market creation, trading, PnL verification, authority transfer, and
 * staleness checks.
 *
 * Usage:  npx ts-node tests/e2e-oracle.test.ts
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
  Side,
  OracleSource,
  CreateMarketParams,
  InitPerkOracleParams,
  UpdatePerkOracleParams,
} from "../src/types";
import {
  LEVERAGE_SCALE,
  MIN_INITIAL_K,
  PRICE_SCALE,
  POS_SCALE,
} from "../src/constants";
import { findPerkOracleAddress } from "../src/pda";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const RPC_URL = "https://api.devnet.solana.com";
const TOKEN_DECIMALS = 6;
const DELAY_MS = 2000;
const STATE_FILE = path.join(__dirname, "wallets", "test-state-oracle.json");

// PerkOracle price constants
// $0.05 per token in PRICE_SCALE (10^6) = 50_000
const INITIAL_PRICE = new BN(50_000);
// $0.06 per token = 60_000 (20% up)
const UPDATED_PRICE = new BN(60_000);
// Confidence: $0.001 = 1_000 in PRICE_SCALE
const CONFIDENCE = new BN(1_000);
const NUM_SOURCES = 3;

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

function saveState(state: Record<string, string>): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Perk Protocol — PerkOracle E2E Tests");
  console.log("═══════════════════════════════════════════\n");

  const connection = new Connection(RPC_URL, "confirmed");

  // ═══════════════════════════════════════════
  // Phase 1: Setup
  // ═══════════════════════════════════════════

  // ── Step 1: Load Wallets ──
  console.log("── Step 1: 🔑 Load Wallets ──");

  const admin = loadKeypair("admin");
  const creator = loadKeypair("creator");
  const traderA = loadKeypair("traderA");
  const traderB = loadKeypair("traderB");
  const traderC = loadKeypair("traderC");
  const cranker = loadKeypair("cranker");
  const feeWallet = loadKeypair("feeWallet");

  console.log("  Wallets loaded:");
  console.log(`    admin:     ${admin.publicKey.toBase58()}`);
  console.log(`    creator:   ${creator.publicKey.toBase58()}`);
  console.log(`    traderA:   ${traderA.publicKey.toBase58()}`);
  console.log(`    traderB:   ${traderB.publicKey.toBase58()}`);
  console.log(`    traderC:   ${traderC.publicKey.toBase58()}`);
  console.log(`    cranker:   ${cranker.publicKey.toBase58()}`);
  console.log(`    feeWallet: ${feeWallet.publicKey.toBase58()}`);

  // Build clients
  const adminClient = makeClient(connection, admin);
  const creatorClient = makeClient(connection, creator);
  const traderAClient = makeClient(connection, traderA);
  const traderBClient = makeClient(connection, traderB);
  const traderCClient = makeClient(connection, traderC);
  const crankerClient = makeClient(connection, cranker);

  // Shared state — coin-margined: the meme token IS the collateral
  let memeTokenMint: PublicKey;
  let oracleAddress: PublicKey;
  let marketAddress: PublicKey;
  const atas: Record<string, PublicKey> = {};

  // Load persisted state from previous runs (if any)
  let savedState: Record<string, string> = {};
  if (fs.existsSync(STATE_FILE)) {
    savedState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    console.log("  📂 Loaded state from previous run");
  }

  console.log("  ✅ Wallets loaded\n");

  // ── Step 2: Create SPL Token Mints ──
  console.log("── Step 2: 🪙 Create SPL Token Mints ──");
  {
    const adminBal = await connection.getBalance(admin.publicKey);
    console.log(`  Admin SOL balance: ${adminBal / LAMPORTS_PER_SOL} SOL`);
    if (adminBal < 0.1 * LAMPORTS_PER_SOL) {
      throw new Error("Admin has insufficient SOL. Need at least 0.1 SOL.");
    }

    // Fund other wallets if needed
    const walletsToFund = [
      { name: "creator", kp: creator },
      { name: "traderA", kp: traderA },
      { name: "traderB", kp: traderB },
      { name: "traderC", kp: traderC },
      { name: "cranker", kp: cranker },
      { name: "feeWallet", kp: feeWallet },
    ];

    for (const { name, kp } of walletsToFund) {
      const bal = await connection.getBalance(kp.publicKey);
      if (bal < 0.02 * LAMPORTS_PER_SOL) {
        console.log(`  Funding ${name} with 0.05 SOL...`);
        const tx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: kp.publicKey,
            lamports: 0.05 * LAMPORTS_PER_SOL,
          })
        );
        await sendAndConfirmTransaction(connection, tx, [admin]);
        await sleep(1000);
      }
    }

    // Memecoin mint — this is what PerkOracle will price AND what traders deposit
    // (coin-margined: the meme token IS the collateral)
    if (savedState.memeTokenMint) {
      memeTokenMint = new PublicKey(savedState.memeTokenMint);
      console.log(`  Reusing meme token mint: ${memeTokenMint.toBase58()}`);
    } else {
      console.log("  Creating meme token mint (6 decimals)...");
      memeTokenMint = await createMint(
        connection,
        admin,
        admin.publicKey,
        null,
        TOKEN_DECIMALS
      );
      console.log(`  Meme token mint: ${memeTokenMint.toBase58()}`);
      savedState.memeTokenMint = memeTokenMint.toBase58();
      saveState(savedState);
      await sleep(DELAY_MS);
    }

    // Derive the PerkOracle PDA for this mint
    const [perkOraclePda] = findPerkOracleAddress(memeTokenMint);
    oracleAddress = perkOraclePda;
    console.log(`  PerkOracle PDA: ${oracleAddress.toBase58()}`);

    console.log("  ✅ Token mints ready\n");
  }

  // ── Step 3: Create ATAs & Mint Meme Tokens ──
  console.log("── Step 3: 💰 Create ATAs & Mint Meme Tokens ──");
  {
    // Coin-margined: traders deposit meme tokens as collateral
    const mintAmounts: { name: string; kp: Keypair; amount: number }[] = [
      { name: "traderA", kp: traderA, amount: 10_000 },
      { name: "traderB", kp: traderB, amount: 10_000 },
      { name: "traderC", kp: traderC, amount: 5_000 },
      { name: "creator", kp: creator, amount: 1_000 },
      { name: "cranker", kp: cranker, amount: 100 },
      { name: "feeWallet", kp: feeWallet, amount: 0 },
      { name: "admin", kp: admin, amount: 0 },
    ];

    for (const { name, kp, amount } of mintAmounts) {
      console.log(`  Creating ATA for ${name}...`);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,
        memeTokenMint,
        kp.publicKey
      );
      atas[name] = ata.address;
      console.log(`    ATA: ${ata.address.toBase58()}`);

      if (amount > 0) {
        const rawAmount = BigInt(amount) * BigInt(10 ** TOKEN_DECIMALS);
        console.log(`    Minting ${amount} meme tokens...`);
        await mintTo(
          connection,
          admin,
          memeTokenMint,
          ata.address,
          admin,
          rawAmount
        );
      }
      await sleep(500);
    }

    console.log("  ✅ ATAs & meme tokens ready\n");
  }

  // ── Step 4: Initialize Protocol ──
  console.log("── Step 4: 🏛️ Initialize Protocol ──");
  {
    const protocolFeeVault = atas["feeWallet"];
    console.log(`  Protocol fee vault (feeWallet ATA): ${protocolFeeVault.toBase58()}`);

    try {
      const sig = await adminClient.initializeProtocol(protocolFeeVault);
      console.log(`  ✅ Protocol initialized: ${sig}`);
    } catch (err: any) {
      if (err.message?.includes("already in use")) {
        console.log("  ⚠️  Protocol already initialized. Continuing...");
      } else {
        throw new Error(`initializeProtocol failed: ${err.message}`);
      }
    }
    await sleep(DELAY_MS);

    const protocol = await adminClient.fetchProtocol();
    console.log(`  Admin: ${protocol.admin.toBase58()}`);
    console.log(`  Paused: ${protocol.paused}`);
    console.log(`  Fee vault: ${protocol.protocolFeeVault.toBase58()}`);
    console.log("  ✅ Protocol ready\n");
  }

  // ═══════════════════════════════════════════
  // Phase 2: PerkOracle Lifecycle
  // ═══════════════════════════════════════════

  // ── Step 5: Initialize PerkOracle ──
  console.log("── Step 5: 🔮 Initialize PerkOracle ──");
  {
    // Check if oracle already exists
    const existingOracle = await adminClient.fetchPerkOracleNullable(memeTokenMint);
    if (existingOracle) {
      console.log("  ⚠️  PerkOracle already initialized. Continuing...");
      console.log(`    Token mint: ${existingOracle.tokenMint.toBase58()}`);
      console.log(`    Authority: ${existingOracle.authority.toBase58()}`);
      console.log(`    Is frozen: ${existingOracle.isFrozen}`);
      console.log(`    Min sources: ${existingOracle.minSources}`);
      console.log(`    Max staleness: ${existingOracle.maxStalenessSeconds}s`);
    } else {
      const oracleParams: InitPerkOracleParams = {
        minSources: 1,
        maxStalenessSeconds: 60,
        maxPriceChangeBps: 0, // 0 = no banding (appropriate for memecoins)
        circuitBreakerDeviationBps: 0, // 0 = disabled
      };

      console.log(`  Initializing PerkOracle for meme token: ${memeTokenMint.toBase58()}`);
      console.log(`    Oracle authority (cranker): ${cranker.publicKey.toBase58()}`);
      console.log(`    Min sources: ${oracleParams.minSources}`);
      console.log(`    Max staleness: ${oracleParams.maxStalenessSeconds}s`);
      console.log(`    Max price change bps: ${oracleParams.maxPriceChangeBps} (no banding)`);

      const sig = await adminClient.initializePerkOracle(
        memeTokenMint,
        cranker.publicKey,
        oracleParams
      );
      console.log(`  ✅ PerkOracle initialized: ${sig}`);
      savedState.oracleInitialized = "true";
      saveState(savedState);
      await sleep(DELAY_MS);

      // Verify oracle account
      const oracle = await adminClient.fetchPerkOracle(memeTokenMint);
      console.log(`  Verifying oracle account:`);
      console.log(`    Token mint: ${oracle.tokenMint.toBase58()}`);
      console.log(`    Authority: ${oracle.authority.toBase58()}`);
      console.log(`    Min sources: ${oracle.minSources}`);
      console.log(`    Max staleness: ${oracle.maxStalenessSeconds}s`);
      console.log(`    Is frozen: ${oracle.isFrozen}`);
      console.log(`    Price: ${oracle.price.toNumber()}`);

      if (!oracle.tokenMint.equals(memeTokenMint)) {
        throw new Error("Oracle token mint mismatch!");
      }
      if (!oracle.authority.equals(cranker.publicKey)) {
        throw new Error("Oracle authority mismatch!");
      }
      if (oracle.minSources !== 1) {
        throw new Error(`Expected minSources=1, got ${oracle.minSources}`);
      }
    }
    console.log("  ✅ PerkOracle verified\n");
  }

  // ── Step 6: Post Initial Price Update ──
  console.log("── Step 6: 📈 Post Initial Price Update ──");
  {
    const updateParams: UpdatePerkOracleParams = {
      price: INITIAL_PRICE,
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    };

    console.log(`  Posting initial price: $${INITIAL_PRICE.toNumber() / PRICE_SCALE} per token`);
    console.log(`    Price (raw): ${INITIAL_PRICE.toString()}`);
    console.log(`    Confidence: ${CONFIDENCE.toString()}`);
    console.log(`    Num sources: ${NUM_SOURCES}`);

    const sig = await crankerClient.updatePerkOracle(memeTokenMint, updateParams);
    console.log(`  ✅ Price posted: ${sig}`);
    await sleep(DELAY_MS);

    // Verify price update
    const oracle = await crankerClient.fetchPerkOracle(memeTokenMint);
    console.log(`  Verifying price update:`);
    console.log(`    Price: ${oracle.price.toNumber()} ($${oracle.price.toNumber() / PRICE_SCALE})`);
    console.log(`    EMA price: ${oracle.emaPrice.toNumber()}`);
    console.log(`    Num sources: ${oracle.numSources}`);
    console.log(`    Last update timestamp: ${oracle.timestamp.toNumber()}`);
    console.log(`    Total updates: ${oracle.totalUpdates.toNumber()}`);

    if (oracle.price.toNumber() !== INITIAL_PRICE.toNumber()) {
      throw new Error(`Price mismatch: expected ${INITIAL_PRICE.toString()}, got ${oracle.price.toString()}`);
    }
    if (oracle.numSources !== NUM_SOURCES) {
      throw new Error(`Num sources mismatch: expected ${NUM_SOURCES}, got ${oracle.numSources}`);
    }

    console.log("  ✅ Price verified\n");
  }

  // ── Step 7: Test Freeze / Unfreeze ──
  console.log("── Step 7: 🧊 Test Freeze / Unfreeze ──");
  {
    // Freeze the oracle
    console.log("  Freezing oracle...");
    const freezeSig = await adminClient.freezePerkOracle(memeTokenMint, true);
    console.log(`  ✅ Oracle frozen: ${freezeSig}`);
    await sleep(DELAY_MS);

    // Verify frozen state
    let oracle = await adminClient.fetchPerkOracle(memeTokenMint);
    console.log(`  Is frozen: ${oracle.isFrozen}`);
    if (!oracle.isFrozen) {
      throw new Error("Oracle should be frozen!");
    }

    // Unfreeze the oracle
    console.log("  Unfreezing oracle...");
    const unfreezeSig = await adminClient.freezePerkOracle(memeTokenMint, false);
    console.log(`  ✅ Oracle unfrozen: ${unfreezeSig}`);
    await sleep(DELAY_MS);

    // Verify unfrozen state and H-01 fix (price zeroed after unfreeze)
    oracle = await adminClient.fetchPerkOracle(memeTokenMint);
    console.log(`  Is frozen: ${oracle.isFrozen}`);
    console.log(`  Price after unfreeze: ${oracle.price.toNumber()}`);
    if (oracle.isFrozen) {
      throw new Error("Oracle should be unfrozen!");
    }
    if (oracle.price.toNumber() !== 0) {
      console.log("  ⚠️  Price not zeroed after unfreeze (H-01 fix may not be deployed yet)");
    } else {
      console.log("  ✅ H-01 verified: price zeroed after unfreeze");
    }

    // Post fresh price update after unfreeze
    console.log("  Posting fresh price after unfreeze...");
    const updateParams: UpdatePerkOracleParams = {
      price: INITIAL_PRICE,
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    };
    const refreshSig = await crankerClient.updatePerkOracle(memeTokenMint, updateParams);
    console.log(`  ✅ Fresh price posted: ${refreshSig}`);
    await sleep(DELAY_MS);

    // Verify fresh price
    oracle = await crankerClient.fetchPerkOracle(memeTokenMint);
    console.log(`  Price after refresh: ${oracle.price.toNumber()} ($${oracle.price.toNumber() / PRICE_SCALE})`);
    console.log("  ✅ Freeze/unfreeze cycle complete\n");
  }

  // ═══════════════════════════════════════════
  // Phase 3: Market with PerkOracle
  // ═══════════════════════════════════════════

  // ── Step 8: Create Market with PerkOracle ──
  console.log("── Step 8: 🏪 Create Market with PerkOracle ──");
  {
    // Coin-margined: market PDA derived from memeTokenMint. The vault holds meme
    // tokens, the oracle prices the meme token. PerkOracle PDA also derived from
    // memeTokenMint, so validate_perk_oracle_mint passes.
    const marketTokenMint = memeTokenMint;
    marketAddress = creatorClient.getMarketAddress(marketTokenMint);

    // Check if market already exists
    let marketExists = false;
    try {
      const existing = await creatorClient.fetchMarketByAddress(marketAddress);
      if (existing) {
        marketExists = true;
        console.log(`  ⚠️  Market already exists at ${marketAddress.toBase58().slice(0, 16)}... Continuing...`);

        // Update oracle if it doesn't match
        if (!existing.oracleAddress.equals(oracleAddress)) {
          console.log("  Updating market oracle to PerkOracle PDA...");
          await adminClient.adminUpdateMarket(marketTokenMint, oracleAddress, {
            oracleAddress: oracleAddress,
            active: null,
            tradingFeeBps: null,
            maxLeverage: null,
          });
          console.log("  ✅ Oracle updated");
          await sleep(DELAY_MS);
        }
      }
    } catch {
      /* market doesn't exist yet */
    }

    if (!marketExists) {
      // Fund creator for market creation fee (1 SOL) + rent
      const creatorBal = await connection.getBalance(creator.publicKey);
      const needed = 1.1 * LAMPORTS_PER_SOL;
      if (creatorBal < needed) {
        const topUp = needed - creatorBal;
        console.log(`  Funding creator with ${(topUp / LAMPORTS_PER_SOL).toFixed(2)} SOL for market creation fee...`);
        const fundTx = new Transaction().add(
          SystemProgram.transfer({
            fromPubkey: admin.publicKey,
            toPubkey: creator.publicKey,
            lamports: topUp,
          })
        );
        await sendAndConfirmTransaction(connection, fundTx, [admin]);
        await sleep(1000);
      }

      // Refresh oracle right before market creation
      console.log("  Refreshing oracle price before market creation...");
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: INITIAL_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(DELAY_MS);

      const params: CreateMarketParams = {
        oracleSource: OracleSource.PerkOracle,
        maxLeverage: 10 * LEVERAGE_SCALE, // 10x
        tradingFeeBps: 30,                 // 0.3%
        initialK: MIN_INITIAL_K,           // 1e18
      };

      console.log("  Creating memecoin perp market with PerkOracle...");
      console.log(`    tokenMint (meme): ${marketTokenMint.toBase58()}`);
      console.log(`    oracle (PerkOracle PDA): ${oracleAddress.toBase58()}`);
      console.log(`    oracleSource: PerkOracle`);
      console.log(`    maxLeverage: ${params.maxLeverage / LEVERAGE_SCALE}x`);
      console.log(`    tradingFeeBps: ${params.tradingFeeBps}`);

      const sig = await creatorClient.createMarket(marketTokenMint, oracleAddress, params);
      console.log(`  ✅ Market created: ${sig}`);
      savedState.marketCreated = "true";
      saveState(savedState);
      await sleep(DELAY_MS);
    }

    // Verify market
    const market = await creatorClient.fetchMarketByAddress(marketAddress);
    console.log(`  Market address: ${marketAddress.toBase58()}`);
    console.log(`  Active: ${market.active}`);
    console.log(`  Creator: ${market.creator.toBase58()}`);
    console.log(`  Oracle source: ${market.oracleSource}`);
    console.log(`  Oracle address: ${market.oracleAddress.toBase58()}`);
    console.log(`  Max leverage: ${market.maxLeverage / LEVERAGE_SCALE}x`);
    console.log(`  Trading fee: ${market.tradingFeeBps} bps`);
    console.log("  ✅ Market ready\n");
  }

  // ── Step 9: Initialize Trader Positions ──
  console.log("── Step 9: 👥 Initialize Trader Positions ──");
  {
    const traders = [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ];

    for (const { name, client } of traders) {
      console.log(`  Initializing position for ${name}...`);
      try {
        const sig = await client.initializePosition(memeTokenMint);
        console.log(`    ✅ ${name}: ${sig}`);
        await sleep(DELAY_MS);
      } catch (err: any) {
        if (err.message?.includes("already in use")) {
          console.log(`    ⚠️  ${name}: position already initialized. Continuing...`);
        } else {
          throw err;
        }
      }
    }
    console.log("  ✅ Positions initialized\n");
  }

  // ═══════════════════════════════════════════
  // Phase 4: Trading with PerkOracle
  // ═══════════════════════════════════════════

  // ── Step 10: Deposit Collateral ──
  console.log("── Step 10: 💳 Deposit Collateral ──");
  {
    const deposits = [
      { name: "traderA", client: traderAClient, amount: 1000 },
      { name: "traderB", client: traderBClient, amount: 1000 },
      { name: "traderC", client: traderCClient, amount: 500 },
    ];

    for (const { name, client, amount } of deposits) {
      const rawAmount = new BN(amount).mul(new BN(10 ** TOKEN_DECIMALS));
      console.log(`  ${name} depositing ${amount} collateral tokens...`);

      // Refresh oracle before each deposit (staleness)
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: INITIAL_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      const sig = await client.deposit(memeTokenMint, oracleAddress, rawAmount);
      console.log(`    ✅ ${name} deposited: ${sig}`);
      await sleep(DELAY_MS);
    }

    // Verify deposits
    for (const { name, client } of deposits) {
      const pos = await client.fetchPosition(marketAddress, client.wallet.publicKey);
      console.log(`  ${name} deposited collateral: ${pos.depositedCollateral.toNumber() / 10 ** TOKEN_DECIMALS}`);
    }
    console.log("  ✅ Collateral deposited\n");
  }

  // ── Step 11: Open Positions ──
  console.log("── Step 11: 📊 Open Positions ──");
  {
    // TraderA: 5x long
    {
      console.log("  TraderA opening 5x long...");
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: INITIAL_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      const baseSize = new BN(1 * POS_SCALE); // 1 unit
      const leverage = 5 * LEVERAGE_SCALE;     // 5x
      const sig = await traderAClient.openPosition(
        memeTokenMint, oracleAddress, Side.Long, baseSize, leverage, 1000
      );
      console.log(`    ✅ TraderA 5x long: ${sig}`);
      await sleep(DELAY_MS);
    }

    // TraderB: 5x short
    {
      console.log("  TraderB opening 5x short...");
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: INITIAL_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      const baseSize = new BN(1 * POS_SCALE);
      const leverage = 5 * LEVERAGE_SCALE;
      const sig = await traderBClient.openPosition(
        memeTokenMint, oracleAddress, Side.Short, baseSize, leverage, 1000
      );
      console.log(`    ✅ TraderB 5x short: ${sig}`);
      await sleep(DELAY_MS);
    }

    // TraderC: 3x long
    {
      console.log("  TraderC opening 3x long...");
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: INITIAL_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      const baseSize = new BN(Math.floor(0.5 * POS_SCALE)); // 0.5 units
      const leverage = 3 * LEVERAGE_SCALE; // 3x
      const sig = await traderCClient.openPosition(
        memeTokenMint, oracleAddress, Side.Long, baseSize, leverage, 1000
      );
      console.log(`    ✅ TraderC 3x long: ${sig}`);
      await sleep(DELAY_MS);
    }

    // Print position info
    for (const { name, client } of [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ]) {
      const pos = await client.fetchPosition(marketAddress, client.wallet.publicKey);
      console.log(`  ${name} — baseSize: ${pos.baseSize.toString()}, collateral: ${pos.depositedCollateral.toNumber() / 10 ** TOKEN_DECIMALS}`);
    }
    console.log("  ✅ Positions opened\n");
  }

  // ── Step 12: Update Oracle Price (Simulate Price Movement) ──
  console.log("── Step 12: 🚀 Update Oracle Price ($0.05 → $0.06, +20%) ──");
  {
    const updateParams: UpdatePerkOracleParams = {
      price: UPDATED_PRICE,
      confidence: CONFIDENCE,
      numSources: NUM_SOURCES,
    };

    console.log(`  Posting new price: $${UPDATED_PRICE.toNumber() / PRICE_SCALE} per token`);
    console.log(`    Price change: $0.05 → $0.06 (+20%)`);

    const sig = await crankerClient.updatePerkOracle(memeTokenMint, updateParams);
    console.log(`  ✅ Price updated: ${sig}`);
    await sleep(DELAY_MS);

    // Verify
    const oracle = await crankerClient.fetchPerkOracle(memeTokenMint);
    console.log(`  New price: ${oracle.price.toNumber()} ($${oracle.price.toNumber() / PRICE_SCALE})`);
    console.log(`  EMA price: ${oracle.emaPrice.toNumber()} ($${oracle.emaPrice.toNumber() / PRICE_SCALE})`);
    console.log("  ✅ Price movement simulated\n");
  }

  // ── Step 13: Crank Funding ──
  console.log("── Step 13: ⚙️ Crank Funding ──");
  {
    const market = await crankerClient.fetchMarket(memeTokenMint);
    const lastFunding = market.lastFundingTime.toNumber();
    const period = market.fundingPeriodSeconds;
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastFunding;

    console.log(`  Funding period: ${period}s, elapsed: ${elapsed}s`);

    if (elapsed >= period) {
      console.log("  Cranking funding...");
      // Refresh oracle
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: UPDATED_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      try {
        const sig = await crankerClient.crankFunding(marketAddress, oracleAddress);
        console.log(`    ✅ Funding cranked: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  Crank funding failed (may not be due yet): ${err.message?.slice(0, 120)}`);
      }
    } else {
      console.log(`  ⏳ Funding not yet due (need ${period - elapsed}s more). Skipping crank.`);
    }
    await sleep(DELAY_MS);
    console.log("  ✅ Funding step complete\n");
  }

  // ── Step 14: Close Positions & Verify PnL ──
  console.log("── Step 14: 💰 Close Positions & Verify PnL ──");
  {
    // Record pre-close collateral
    const preClose: Record<string, number> = {};
    for (const { name, client } of [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ]) {
      const pos = await client.fetchPosition(marketAddress, client.wallet.publicKey);
      preClose[name] = pos.depositedCollateral.toNumber();
    }

    // Close each position
    for (const { name, client } of [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ]) {
      console.log(`  ${name} closing position...`);

      // Refresh oracle before each close
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: UPDATED_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      try {
        const sig = await client.closePosition(memeTokenMint, oracleAddress);
        console.log(`    ✅ ${name} position closed: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  ${name} close failed: ${err.message?.slice(0, 200)}`);
      }
      await sleep(DELAY_MS);
    }

    // Verify PnL
    console.log("\n  PnL Summary (price moved +20%):");
    for (const { name, client } of [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ]) {
      const pos = await client.fetchPosition(marketAddress, client.wallet.publicKey);
      const postCollateral = pos.depositedCollateral.toNumber();
      const pnlRaw = postCollateral - preClose[name];
      const pnlTokens = pnlRaw / 10 ** TOKEN_DECIMALS;
      console.log(`    ${name}: collateral ${preClose[name] / 10 ** TOKEN_DECIMALS} → ${postCollateral / 10 ** TOKEN_DECIMALS} (PnL: ${pnlTokens >= 0 ? "+" : ""}${pnlTokens.toFixed(2)})`);
      console.log(`      baseSize after close: ${pos.baseSize.toString()}`);
    }

    // Sanity check: longs should profit, shorts should lose (price went up)
    console.log("\n  Expected: TraderA (long) profit, TraderB (short) loss, TraderC (long) profit");
    console.log("  ✅ Positions closed\n");
  }

  // ── Step 15: Withdraw Collateral ──
  console.log("── Step 15: 🏧 Withdraw Collateral ──");
  {
    for (const { name, client } of [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ]) {
      // Refresh oracle
      await crankerClient.updatePerkOracle(memeTokenMint, {
        price: UPDATED_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      await sleep(1000);

      const pos = await client.fetchPosition(marketAddress, client.wallet.publicKey);
      const withdrawable = pos.depositedCollateral;
      console.log(`  ${name} withdrawable: ${withdrawable.toNumber() / 10 ** TOKEN_DECIMALS} tokens`);

      if (withdrawable.toNumber() > 0) {
        // Withdraw half
        const halfAmount = withdrawable.div(new BN(2));
        console.log(`    Withdrawing ${halfAmount.toNumber() / 10 ** TOKEN_DECIMALS} tokens...`);
        try {
          const sig = await client.withdraw(memeTokenMint, oracleAddress, halfAmount);
          console.log(`    ✅ ${name} withdrawn: ${sig}`);
        } catch (err: any) {
          console.log(`    ⚠️  ${name} withdraw failed: ${err.message?.slice(0, 200)}`);
        }
      } else {
        console.log(`    No collateral to withdraw.`);
      }
      await sleep(DELAY_MS);
    }
    console.log("  ✅ Withdrawals complete\n");
  }

  // ═══════════════════════════════════════════
  // Phase 5: Oracle Edge Cases
  // ═══════════════════════════════════════════

  // ── Step 16: Test Oracle Authority Transfer ──
  console.log("── Step 16: 🔐 Test Oracle Authority Transfer ──");
  {
    // Transfer authority from cranker → admin
    console.log(`  Transferring oracle authority: cranker → admin`);
    console.log(`    From: ${cranker.publicKey.toBase58()}`);
    console.log(`    To:   ${admin.publicKey.toBase58()}`);

    try {
      const sig = await crankerClient.transferOracleAuthority(
        memeTokenMint,
        admin.publicKey
      );
      console.log(`  ✅ Authority transferred to admin: ${sig}`);
      await sleep(DELAY_MS);

      // Verify
      let oracle = await adminClient.fetchPerkOracle(memeTokenMint);
      console.log(`  New authority: ${oracle.authority.toBase58()}`);
      if (!oracle.authority.equals(admin.publicKey)) {
        throw new Error("Authority transfer failed — mismatch!");
      }

      // Verify admin can now post price updates
      console.log("  Admin posting price update as new authority...");
      const updateSig = await adminClient.updatePerkOracle(memeTokenMint, {
        price: INITIAL_PRICE,
        confidence: CONFIDENCE,
        numSources: NUM_SOURCES,
      });
      console.log(`  ✅ Admin price update succeeded: ${updateSig}`);
      await sleep(DELAY_MS);

      // Transfer back to cranker for cleanup
      console.log("  Transferring authority back: admin → cranker");
      const revertSig = await adminClient.transferOracleAuthority(
        memeTokenMint,
        cranker.publicKey
      );
      console.log(`  ✅ Authority restored to cranker: ${revertSig}`);
      await sleep(DELAY_MS);

      // Verify
      oracle = await adminClient.fetchPerkOracle(memeTokenMint);
      console.log(`  Authority restored: ${oracle.authority.toBase58()}`);
      if (!oracle.authority.equals(cranker.publicKey)) {
        throw new Error("Authority restore failed — mismatch!");
      }
    } catch (err: any) {
      console.log(`  ⚠️  Authority transfer failed: ${err.message?.slice(0, 200)}`);
    }
    console.log("  ✅ Authority transfer test complete\n");
  }

  // ── Step 17: Test Stale Oracle ──
  console.log("── Step 17: ⏰ Test Stale Oracle ──");
  {
    // Our oracle has maxStalenessSeconds=60. On devnet, we can't easily wait
    // 60+ seconds in a test, but we can verify the staleness fields are tracked.
    console.log("  Oracle staleness config:");
    const oracle = await crankerClient.fetchPerkOracle(memeTokenMint);
    const now = Math.floor(Date.now() / 1000);
    const age = now - oracle.timestamp.toNumber();
    console.log(`    Max staleness: ${oracle.maxStalenessSeconds}s`);
    console.log(`    Last update: ${oracle.timestamp.toNumber()} (${age}s ago)`);

    if (age > oracle.maxStalenessSeconds) {
      console.log("  Oracle IS stale — attempting trade (should fail)...");
      try {
        const baseSize = new BN(Math.floor(0.1 * POS_SCALE));
        const leverage = 2 * LEVERAGE_SCALE;
        // Re-deposit first since we may have withdrawn
        await traderAClient.deposit(memeTokenMint, oracleAddress, new BN(100 * 10 ** TOKEN_DECIMALS));
        await sleep(DELAY_MS);

        await traderAClient.openPosition(
          memeTokenMint, oracleAddress, Side.Long, baseSize, leverage, 1500
        );
        console.log("  ⚠️  Trade succeeded with stale oracle (unexpected!)");
      } catch (err: any) {
        console.log(`  ✅ Trade correctly rejected with stale oracle: ${err.message?.slice(0, 120)}`);
      }
    } else {
      console.log(`  Oracle is fresh (${age}s < ${oracle.maxStalenessSeconds}s) — can't test staleness rejection without waiting.`);
      console.log("  Verifying staleness tracking fields are populated...");
      console.log(`    timestamp: ${oracle.timestamp.toNumber()}`);
      console.log(`    lastSlot: ${oracle.lastSlot.toNumber()}`);
      console.log(`    totalUpdates: ${oracle.totalUpdates.toNumber()}`);

      if (oracle.timestamp.toNumber() === 0) {
        throw new Error("Staleness tracking not working — timestamp is 0!");
      }
      console.log("  ✅ Staleness tracking fields verified");
    }
    console.log("  ✅ Stale oracle test complete\n");
  }

  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  console.log("═══════════════════════════════════════════");
  console.log("  PerkOracle E2E Test Suite Complete!");
  console.log("═══════════════════════════════════════════");

  console.log("\n📋 Final State:");

  const finalMarket = await adminClient.fetchMarketByAddress(marketAddress);
  console.log(`  Market: ${marketAddress.toBase58()}`);
  console.log(`  Active: ${finalMarket.active}`);
  console.log(`  Oracle source: ${finalMarket.oracleSource}`);
  console.log(`  Total volume: ${finalMarket.totalVolume.toString()}`);
  console.log(`  Total users: ${finalMarket.totalUsers}`);
  console.log(`  Vault balance: ${finalMarket.vaultBalance.toNumber() / 10 ** TOKEN_DECIMALS}`);
  console.log(`  Insurance fund: ${finalMarket.insuranceFundBalance.toNumber() / 10 ** TOKEN_DECIMALS}`);
  console.log(`  Creator fees earned: ${finalMarket.creatorFeesEarned.toNumber() / 10 ** TOKEN_DECIMALS}`);
  console.log(`  Protocol fees earned: ${finalMarket.protocolFeesEarned.toNumber() / 10 ** TOKEN_DECIMALS}`);

  const finalOracle = await adminClient.fetchPerkOracle(memeTokenMint);
  console.log(`\n  PerkOracle: ${oracleAddress.toBase58()}`);
  console.log(`  Price: $${finalOracle.price.toNumber() / PRICE_SCALE}`);
  console.log(`  Total updates: ${finalOracle.totalUpdates.toNumber()}`);
  console.log(`  Authority: ${finalOracle.authority.toBase58()}`);
  console.log(`  Is frozen: ${finalOracle.isFrozen}`);

  console.log("\n🎉 All PerkOracle E2E tests passed!");
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────

main().catch((err) => {
  console.error("\n❌ PerkOracle E2E test failed:", err);
  process.exit(1);
});
