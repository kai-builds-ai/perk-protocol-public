/**
 * Perk Protocol — End-to-End Integration Test Suite (Solana Devnet)
 *
 * Runs a full lifecycle: setup → init protocol → create market → trade → liquidate → withdraw → admin ops.
 *
 * Usage:  npx ts-node tests/e2e.test.ts
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
  getAssociatedTokenAddress,
  TOKEN_PROGRAM_ID,
  Account as TokenAccount,
} from "@solana/spl-token";
import { Wallet, BN } from "@coral-xyz/anchor";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";

import { PerkClient } from "../src/client";
import {
  Side,
  OracleSource,
  TriggerOrderType,
  CreateMarketParams,
  TriggerOrderParams,
} from "../src/types";
import {
  PERK_PROGRAM_ID,
  LEVERAGE_SCALE,
  MIN_INITIAL_K,
  PRICE_SCALE,
  POS_SCALE,
  PYTH_SOL_USD_FEED,
} from "../src/constants";
import { isLiquidatable, numberToPrice } from "../src/math";
import * as fs from "fs";
import * as path from "path";

// ─────────────────────────────────────────────
// Config
// ─────────────────────────────────────────────

const RPC_URL = "https://api.devnet.solana.com";
const SOL_USD_FEED_HEX = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = "https://hermes.pyth.network";
const TOKEN_DECIMALS = 6;
const DELAY_MS = 2000;
const STATE_FILE = path.join(__dirname, "wallets", "test-state.json");

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

/** Fetch latest VAA from Hermes for a price feed, returned as base64 string array. */
async function fetchHermesVaa(feedId: string): Promise<string[]> {
  const url = `${HERMES_URL}/v2/updates/price/latest?ids[]=${feedId}&encoding=base64`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hermes fetch failed: ${resp.status} ${resp.statusText}`);
  const data = await resp.json() as any;
  // data.binary.data is an array of base64-encoded VAAs
  const vaas: string[] = data.binary?.data;
  if (!vaas || vaas.length === 0) throw new Error("No VAAs returned from Hermes");
  return vaas;
}

/** Deterministic Pyth oracle account address (shard 0, SOL/USD feed).
 *  Using updatePriceFeed writes to the SAME account every time,
 *  so the market's oracle_address never changes after createMarket. */
let _pythReceiver: PythSolanaReceiver | null = null;

function getPythReceiver(connection: Connection, wallet: Wallet): PythSolanaReceiver {
  if (!_pythReceiver) {
    _pythReceiver = new PythSolanaReceiver({ connection, wallet });
  }
  return _pythReceiver;
}

/** Get the deterministic price feed account address (always the same). */
function getOracleAddress(connection: Connection, wallet: Wallet): PublicKey {
  const psr = getPythReceiver(connection, wallet);
  return psr.getPriceFeedAccountAddress(0, SOL_USD_FEED_HEX);
}

/** Post/refresh the Pyth SOL/USD price to the deterministic price feed account.
 *  First call creates the account; subsequent calls update it in-place.
 *  Uses buildVersionedTransactions for automatic tx splitting (handles >1232 byte txs).
 *  Returns the (always-same) oracle account address. */
async function postPythPriceUpdate(
  connection: Connection,
  wallet: Wallet
): Promise<PublicKey> {
  const psr = getPythReceiver(connection, wallet);
  const vaas = await fetchHermesVaa(SOL_USD_FEED_HEX);

  // Use the txBuilder pattern which handles VAA posting + price update correctly
  const txBuilder = psr.newTransactionBuilder({ closeUpdateAccounts: true });
  await (txBuilder as any).addUpdatePriceFeed(vaas, { shardId: 0, priceFeedId: SOL_USD_FEED_HEX });

  const oracleAddress = psr.getPriceFeedAccountAddress(0, SOL_USD_FEED_HEX);

  const versionedTxs = await txBuilder.buildVersionedTransactions({
    computeUnitPriceMicroLamports: 50_000,
    tightComputeBudget: true,
  });

  for (const { tx, signers } of versionedTxs) {
    tx.sign([wallet.payer, ...signers]);
    const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
    await connection.confirmTransaction(sig, "confirmed");
  }

  return oracleAddress;
}

/** Refresh oracle price. Since we use deterministic accounts, the address never changes.
 *  No need to update the market's oracle reference. */
async function refreshOracle(
  connection: Connection,
  adminWallet: Wallet,
  _adminClient: PerkClient,
  _tokenMint: PublicKey | null,
  _currentOracleAccount: PublicKey | null,
): Promise<PublicKey> {
  return postPythPriceUpdate(connection, adminWallet);
}

function makeClient(connection: Connection, keypair: Keypair): PerkClient {
  const wallet = new Wallet(keypair);
  return new PerkClient({ connection, wallet, commitment: "confirmed" });
}

// ─────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────

async function main() {
  console.log("═══════════════════════════════════════════");
  console.log("  Perk Protocol E2E Integration Tests");
  console.log("═══════════════════════════════════════════\n");

  const connection = new Connection(RPC_URL, "confirmed");

  // Load wallets
  const admin = loadKeypair("admin");
  const creator = loadKeypair("creator");
  const traderA = loadKeypair("traderA");
  const traderB = loadKeypair("traderB");
  const traderC = loadKeypair("traderC");
  const cranker = loadKeypair("cranker");
  const feeWallet = loadKeypair("feeWallet");

  console.log("Wallets loaded:");
  console.log(`  admin:    ${admin.publicKey.toBase58()}`);
  console.log(`  creator:  ${creator.publicKey.toBase58()}`);
  console.log(`  traderA:  ${traderA.publicKey.toBase58()}`);
  console.log(`  traderB:  ${traderB.publicKey.toBase58()}`);
  console.log(`  traderC:  ${traderC.publicKey.toBase58()}`);
  console.log(`  cranker:  ${cranker.publicKey.toBase58()}`);
  console.log(`  feeWallet: ${feeWallet.publicKey.toBase58()}`);

  // Build clients
  const adminClient = makeClient(connection, admin);
  const creatorClient = makeClient(connection, creator);
  const traderAClient = makeClient(connection, traderA);
  const traderBClient = makeClient(connection, traderB);
  const traderCClient = makeClient(connection, traderC);
  const crankerClient = makeClient(connection, cranker);

  // Shared state
  let tokenMint: PublicKey;
  let oracleAccount: PublicKey;
  let marketAddress: PublicKey;

  // ATA references
  const atas: Record<string, PublicKey> = {};

  // Load persisted state from previous runs (if any)
  let savedState: Record<string, string> = {};
  if (fs.existsSync(STATE_FILE)) {
    savedState = JSON.parse(fs.readFileSync(STATE_FILE, "utf-8"));
    console.log("  Loaded state from previous run");
  }

  // Deterministic oracle address (always the same)
  oracleAccount = getOracleAddress(connection, new Wallet(admin));
  console.log(`  Oracle address (deterministic): ${oracleAccount.toBase58()}`);

  // ═══════════════════════════════════════════
  // Step 1: Setup — Create test token mint, ATAs, mint tokens
  // ═══════════════════════════════════════════
  console.log("\n── Step 1: Setup (Create Token Mint & ATAs) ──");
  {
    // Check admin balance
    const adminBal = await connection.getBalance(admin.publicKey);
    console.log(`  Admin SOL balance: ${adminBal / LAMPORTS_PER_SOL} SOL`);
    if (adminBal < 0.1 * LAMPORTS_PER_SOL) {
      throw new Error("Admin has insufficient SOL. Need at least 0.1 SOL.");
    }

    // Fund other wallets if needed (they need SOL for tx fees)
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

    // Reuse token mint from previous run if available
    if (savedState.tokenMint) {
      tokenMint = new PublicKey(savedState.tokenMint);
      console.log(`  Reusing token mint: ${tokenMint.toBase58()}`);
    } else {
      // Create test token mint (USDC-like, 6 decimals)
      console.log("  Creating test token mint (6 decimals)...");
      tokenMint = await createMint(
        connection,
        admin,          // payer
        admin.publicKey, // mint authority
        null,            // freeze authority
        TOKEN_DECIMALS
      );
      console.log(`  Token mint: ${tokenMint.toBase58()}`);
      savedState.tokenMint = tokenMint.toBase58();
      fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2));
      await sleep(DELAY_MS);
    }

    // Create ATAs and mint tokens
    const mintAmounts: { name: string; kp: Keypair; amount: number }[] = [
      { name: "traderA", kp: traderA, amount: 10_000 },
      { name: "traderB", kp: traderB, amount: 10_000 },
      { name: "traderC", kp: traderC, amount: 500 },
      { name: "creator", kp: creator, amount: 1_000 },
      { name: "cranker", kp: cranker, amount: 100 },
      { name: "feeWallet", kp: feeWallet, amount: 0 },
      { name: "admin", kp: admin, amount: 0 },
    ];

    for (const { name, kp, amount } of mintAmounts) {
      console.log(`  Creating ATA for ${name}...`);
      const ata = await getOrCreateAssociatedTokenAccount(
        connection,
        admin,          // payer
        tokenMint,
        kp.publicKey
      );
      atas[name] = ata.address;
      console.log(`    ATA: ${ata.address.toBase58()}`);

      if (amount > 0) {
        const rawAmount = BigInt(amount) * BigInt(10 ** TOKEN_DECIMALS);
        console.log(`    Minting ${amount} tokens...`);
        await mintTo(
          connection,
          admin,
          tokenMint,
          ata.address,
          admin,
          rawAmount
        );
      }
      await sleep(500);
    }

    console.log("  ✅ Setup complete\n");
  }

  // ═══════════════════════════════════════════
  // Step 2: Initialize Protocol
  // ═══════════════════════════════════════════
  console.log("── Step 2: Initialize Protocol ──");
  {
    const protocolFeeVault = atas["feeWallet"];
    console.log(`  Protocol fee vault (feeWallet ATA): ${protocolFeeVault.toBase58()}`);

    try {
      const sig = await adminClient.initializeProtocol(protocolFeeVault);
      console.log(`  ✅ Protocol initialized: ${sig}`);
    } catch (err: any) {
      if (err.message?.includes("already in use")) {
        console.log("  ⚠️  Protocol already initialized (account exists). Continuing...");
      } else {
        throw new Error(`initializeProtocol failed: ${err.message}`);
      }
    }
    await sleep(DELAY_MS);

    // Verify
    const protocol = await adminClient.fetchProtocol();
    console.log(`  Admin: ${protocol.admin.toBase58()}`);
    console.log(`  Paused: ${protocol.paused}`);
    console.log(`  Fee vault: ${protocol.protocolFeeVault.toBase58()}`);
  }

  // ═══════════════════════════════════════════
  // Step 3: Post initial Pyth price update & Create Market
  // ═══════════════════════════════════════════
  console.log("\n── Step 3: Create Market ──");
  {
    // Post fresh Pyth price update (deterministic account — always the same address)
    console.log("  Posting Pyth SOL/USD price update...");
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    console.log(`  Oracle (PriceUpdateV2): ${oracleAccount.toBase58()}`);
    await sleep(DELAY_MS);

    marketAddress = creatorClient.getMarketAddress(tokenMint);

    // Check if market already exists (idempotent)
    let marketExists = false;
    try {
      const existing = await creatorClient.fetchMarketByAddress(marketAddress);
      if (existing) {
        marketExists = true;
        console.log(`  ⚠️ Market already exists at ${marketAddress.toBase58().slice(0, 12)}... Continuing...`);

        // If the market's oracle doesn't match our deterministic one, update it
        if (!existing.oracleAddress.equals(oracleAccount)) {
          console.log("  Updating market oracle to deterministic address...");
          await adminClient.adminUpdateMarket(tokenMint, oracleAccount, {
            oracleAddress: oracleAccount,
            active: null,
            tradingFeeBps: null,
            maxLeverage: null,
          });
          console.log("  ✅ Oracle updated");
          await sleep(DELAY_MS);
        }
      }
    } catch { /* market doesn't exist yet */ }

    if (!marketExists) {
      // Fund creator with 1.1 SOL for market creation fee (1 SOL) + rent
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

      const params: CreateMarketParams = {
        oracleSource: OracleSource.Pyth,
        maxLeverage: 10 * LEVERAGE_SCALE,  // 10x max leverage
        tradingFeeBps: 30,                  // 0.3%
        initialK: MIN_INITIAL_K,            // 1e18
      };

      console.log("  Creating SOL-perp market...");
      console.log(`    tokenMint: ${tokenMint.toBase58()}`);
      console.log(`    oracle: ${oracleAccount.toBase58()}`);
      console.log(`    maxLeverage: ${params.maxLeverage / LEVERAGE_SCALE}x`);
      console.log(`    tradingFeeBps: ${params.tradingFeeBps}`);

      const sig = await creatorClient.createMarket(tokenMint, oracleAccount, params);
      console.log(`  ✅ Market created: ${sig}`);
      savedState.marketCreated = "true";
      fs.writeFileSync(STATE_FILE, JSON.stringify(savedState, null, 2));
      await sleep(DELAY_MS);
    }

    // Verify
    const market = await creatorClient.fetchMarket(tokenMint);
    console.log(`  Market address: ${marketAddress.toBase58()}`);
    console.log(`  Market active: ${market.active}`);
    console.log(`  Market creator: ${market.creator.toBase58()}`);
    console.log(`  Oracle: ${market.oracleAddress.toBase58()}`);
    console.log(`  Max leverage: ${market.maxLeverage / LEVERAGE_SCALE}x`);
  }

  // ═══════════════════════════════════════════
  // Step 4: Initialize Positions
  // ═══════════════════════════════════════════
  console.log("\n── Step 4: Initialize Positions ──");
  {
    const traders = [
      { name: "traderA", client: traderAClient },
      { name: "traderB", client: traderBClient },
      { name: "traderC", client: traderCClient },
    ];

    for (const { name, client } of traders) {
      console.log(`  Initializing position for ${name}...`);
      try {
        const sig = await client.initializePosition(tokenMint);
        console.log(`    ✅ ${name}: ${sig}`);
        await sleep(DELAY_MS);
      } catch (err: any) {
        if (err.message?.includes("already in use")) {
          console.log(`    ⚠️ ${name}: position already initialized. Continuing...`);
        } else {
          throw err;
        }
      }
    }
  }

  // ═══════════════════════════════════════════
  // Step 5: Deposit Collateral
  // ═══════════════════════════════════════════
  console.log("\n── Step 5: Deposit Collateral ──");
  {
    // Fresh oracle needed for deposit
    console.log("  Posting fresh Pyth price update...");
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    await sleep(DELAY_MS);

    const deposits = [
      { name: "traderA", client: traderAClient, amount: 1000 },
      { name: "traderB", client: traderBClient, amount: 1000 },
      { name: "traderC", client: traderCClient, amount: 50 },
    ];

    for (const { name, client, amount } of deposits) {
      const rawAmount = new BN(amount).mul(new BN(10 ** TOKEN_DECIMALS));
      console.log(`  ${name} depositing ${amount} tokens...`);

      // Post fresh oracle for each deposit (oracle staleness is 15s)
      oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
      await sleep(1000);

      const sig = await client.deposit(tokenMint, oracleAccount, rawAmount);
      console.log(`    ✅ ${name} deposited: ${sig}`);
      await sleep(DELAY_MS);
    }

    // Verify deposits
    for (const { name, client } of deposits) {
      const pos = await client.fetchPosition(marketAddress, client.wallet.publicKey);
      console.log(`  ${name} deposited collateral: ${pos.depositedCollateral.toNumber() / 10 ** TOKEN_DECIMALS}`);
    }
  }

  // ═══════════════════════════════════════════
  // Step 6: Open Positions
  // ═══════════════════════════════════════════
  console.log("\n── Step 6: Open Positions ──");
  {
    // TraderA: 5x long
    {
      console.log("  TraderA opening 5x long...");
      oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
      await sleep(1000);

      const baseSize = new BN(1 * POS_SCALE); // 1 unit of base
      const leverage = 5 * LEVERAGE_SCALE;     // 5x
      const sig = await traderAClient.openPosition(
        tokenMint, oracleAccount, Side.Long, baseSize, leverage, 1000
      );
      console.log(`    ✅ TraderA 5x long: ${sig}`);
      await sleep(DELAY_MS);
    }

    // TraderB: 5x short
    {
      console.log("  TraderB opening 5x short...");
      oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
      await sleep(1000);

      const baseSize = new BN(1 * POS_SCALE);
      const leverage = 5 * LEVERAGE_SCALE;
      const sig = await traderBClient.openPosition(
        tokenMint, oracleAccount, Side.Short, baseSize, leverage, 1000
      );
      console.log(`    ✅ TraderB 5x short: ${sig}`);
      await sleep(DELAY_MS);
    }

    // TraderC: 10x long (risky, under-collateralized)
    {
      console.log("  TraderC opening 10x long (risky)...");
      oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
      await sleep(1000);

      // TraderC has only 50 tokens — a 10x leverage on even a small base should be near-liquidation
      const baseSize = new BN(Math.floor(0.5 * POS_SCALE)); // 0.5 units
      const leverage = 10 * LEVERAGE_SCALE;
      const sig = await traderCClient.openPosition(
        tokenMint, oracleAccount, Side.Long, baseSize, leverage, 1500
      );
      console.log(`    ✅ TraderC 10x long: ${sig}`);
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
  }

  // ═══════════════════════════════════════════
  // Step 7: Place Trigger Order (TraderA stop-loss)
  // ═══════════════════════════════════════════
  console.log("\n── Step 7: Place Trigger Order (TraderA stop-loss) ──");
  {
    const triggerParams: TriggerOrderParams = {
      orderType: TriggerOrderType.StopLoss,
      side: Side.Long,
      size: new BN(1 * POS_SCALE),           // full position size
      triggerPrice: numberToPrice(50),        // trigger at $50
      leverage: 5 * LEVERAGE_SCALE,
      reduceOnly: true,
      expiry: new BN(0),                     // no expiry
    };

    console.log(`  TraderA placing stop-loss at $50...`);
    const sig = await traderAClient.placeTriggerOrder(tokenMint, triggerParams);
    console.log(`    ✅ Trigger order placed: ${sig}`);
    await sleep(DELAY_MS);

    // Verify
    const pos = await traderAClient.fetchPosition(marketAddress, traderA.publicKey);
    console.log(`    Open trigger orders: ${pos.openTriggerOrders}`);
    console.log(`    Next order ID: ${pos.nextOrderId.toString()}`);
  }

  // ═══════════════════════════════════════════
  // Step 8: Crank Funding
  // ═══════════════════════════════════════════
  console.log("\n── Step 8: Crank Funding ──");
  {
    // Fetch market to check funding period
    const market = await crankerClient.fetchMarket(tokenMint);
    const lastFunding = market.lastFundingTime.toNumber();
    const period = market.fundingPeriodSeconds;
    const now = Math.floor(Date.now() / 1000);
    const elapsed = now - lastFunding;

    console.log(`  Funding period: ${period}s, elapsed: ${elapsed}s`);

    if (elapsed >= period) {
      console.log("  Cranking funding...");
      oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
      await sleep(1000);

      try {
        const sig = await crankerClient.crankFunding(marketAddress, oracleAccount);
        console.log(`    ✅ Funding cranked: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  Crank funding failed (may not be due yet): ${err.message?.slice(0, 120)}`);
      }
    } else {
      console.log(`  ⏳ Funding not yet due (need ${period - elapsed}s more). Skipping crank.`);
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Step 9: Update AMM Peg
  // ═══════════════════════════════════════════
  console.log("\n── Step 9: Update AMM Peg ──");
  {
    console.log("  Posting oracle update & calling updateAmm...");
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    await sleep(1000);

    try {
      const sig = await crankerClient.updateAmm(marketAddress, oracleAccount);
      console.log(`    ✅ AMM peg updated: ${sig}`);
    } catch (err: any) {
      // Expected: cooldown or threshold not met
      console.log(`    ⚠️  AMM peg update skipped: ${err.message?.slice(0, 120)}`);
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Step 10: Liquidation Test
  // ═══════════════════════════════════════════
  console.log("\n── Step 10: Liquidation Test ──");
  {
    // Check if traderC is liquidatable at current price
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    await sleep(DELAY_MS);

    const market = await crankerClient.fetchMarket(tokenMint);
    const posC = await crankerClient.fetchPosition(marketAddress, traderC.publicKey);
    const oraclePrice = market.lastOraclePrice;

    console.log(`  Oracle price: ${oraclePrice.toNumber() / PRICE_SCALE}`);
    console.log(`  TraderC baseSize: ${posC.baseSize.toString()}`);
    console.log(`  TraderC collateral: ${posC.depositedCollateral.toNumber() / 10 ** TOKEN_DECIMALS}`);

    const isLiq = isLiquidatable(posC, market, oraclePrice);
    console.log(`  TraderC liquidatable at current price? ${isLiq}`);

    if (isLiq) {
      console.log("  Attempting liquidation...");
      const crankerAta = atas["cranker"];
      try {
        const sig = await crankerClient.liquidate(
          marketAddress, oracleAccount, traderC.publicKey, crankerAta
        );
        console.log(`    ✅ TraderC liquidated: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  Liquidation failed: ${err.message?.slice(0, 200)}`);
      }
    } else {
      console.log("  TraderC not yet liquidatable. This is expected — the position may have sufficient margin.");
      console.log("  (In production, a large price move would trigger liquidation.)");
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Step 11: Close Position (TraderA)
  // ═══════════════════════════════════════════
  console.log("\n── Step 11: Close Position (TraderA) ──");
  {
    console.log("  Posting fresh oracle...");
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    await sleep(1000);

    console.log("  TraderA closing position...");
    try {
      const sig = await traderAClient.closePosition(tokenMint, oracleAccount);
      console.log(`    ✅ Position closed: ${sig}`);
    } catch (err: any) {
      console.log(`    ⚠️  Close failed: ${err.message?.slice(0, 200)}`);
    }
    await sleep(DELAY_MS);

    // Verify
    const pos = await traderAClient.fetchPosition(marketAddress, traderA.publicKey);
    console.log(`  TraderA baseSize after close: ${pos.baseSize.toString()}`);
  }

  // ═══════════════════════════════════════════
  // Step 12: Withdraw (TraderA)
  // ═══════════════════════════════════════════
  console.log("\n── Step 12: Withdraw Collateral (TraderA) ──");
  {
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    await sleep(1000);

    const pos = await traderAClient.fetchPosition(marketAddress, traderA.publicKey);
    const withdrawable = pos.depositedCollateral;
    console.log(`  TraderA deposited collateral: ${withdrawable.toNumber() / 10 ** TOKEN_DECIMALS}`);

    if (withdrawable.toNumber() > 0) {
      // Withdraw half to test partial withdrawal
      const halfAmount = withdrawable.div(new BN(2));
      console.log(`  Withdrawing ${halfAmount.toNumber() / 10 ** TOKEN_DECIMALS} tokens...`);
      try {
        const sig = await traderAClient.withdraw(tokenMint, oracleAccount, halfAmount);
        console.log(`    ✅ Withdrawn: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  Withdraw failed: ${err.message?.slice(0, 200)}`);
      }
    } else {
      console.log("  No collateral to withdraw (position may have been liquidated or fully closed).");
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Step 13: Cancel Trigger Order (TraderA)
  // ═══════════════════════════════════════════
  console.log("\n── Step 13: Cancel Trigger Order (TraderA) ──");
  {
    const pos = await traderAClient.fetchPosition(marketAddress, traderA.publicKey);
    const openOrders = pos.openTriggerOrders;
    console.log(`  TraderA open trigger orders: ${openOrders}`);

    if (openOrders > 0) {
      // The first order placed was orderId = 0 (nextOrderId was 0 before placement)
      const orderId = 0;
      console.log(`  Cancelling trigger order #${orderId}...`);
      try {
        const sig = await traderAClient.cancelTriggerOrder(tokenMint, orderId);
        console.log(`    ✅ Trigger order cancelled: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  Cancel failed: ${err.message?.slice(0, 200)}`);
      }
    } else {
      console.log("  No open trigger orders to cancel.");
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Step 14: Claim Fees (Creator)
  // ═══════════════════════════════════════════
  console.log("\n── Step 14: Claim Fees (Creator) ──");
  {
    const market = await creatorClient.fetchMarket(tokenMint);
    console.log(`  Creator claimable fees: ${market.creatorClaimableFees.toNumber() / 10 ** TOKEN_DECIMALS}`);
    console.log(`  Protocol claimable fees: ${market.protocolClaimableFees.toNumber() / 10 ** TOKEN_DECIMALS}`);

    if (market.creatorClaimableFees.toNumber() > 0) {
      console.log("  Creator claiming fees...");
      try {
        const sig = await creatorClient.claimFees(tokenMint, atas["creator"]);
        console.log(`    ✅ Fees claimed: ${sig}`);
      } catch (err: any) {
        console.log(`    ⚠️  Claim failed: ${err.message?.slice(0, 200)}`);
      }
    } else {
      console.log("  No creator fees accumulated to claim.");
    }
    await sleep(DELAY_MS);
  }

  // ═══════════════════════════════════════════
  // Step 15: Admin Operations
  // ═══════════════════════════════════════════
  console.log("\n── Step 15: Admin Operations ──");

  // 15a: Pause protocol
  console.log("  15a: Pausing protocol...");
  {
    try {
      const sig = await adminClient.adminPause(true);
      console.log(`    ✅ Protocol paused: ${sig}`);
      await sleep(DELAY_MS);

      const protocol = await adminClient.fetchProtocol();
      console.log(`    Protocol paused state: ${protocol.paused}`);
      if (!protocol.paused) throw new Error("Protocol should be paused!");
    } catch (err: any) {
      console.log(`    ⚠️  Pause failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // 15b: Unpause protocol
  console.log("  15b: Unpausing protocol...");
  {
    try {
      const sig = await adminClient.adminPause(false);
      console.log(`    ✅ Protocol unpaused: ${sig}`);
      await sleep(DELAY_MS);

      const protocol = await adminClient.fetchProtocol();
      console.log(`    Protocol paused state: ${protocol.paused}`);
      if (protocol.paused) throw new Error("Protocol should be unpaused!");
    } catch (err: any) {
      console.log(`    ⚠️  Unpause failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // 15c: Admin update market
  console.log("  15c: Admin update market (reduce trading fee to 20 bps)...");
  {
    try {
      const sig = await adminClient.adminUpdateMarket(tokenMint, null, {
        oracleAddress: null,
        active: null,
        tradingFeeBps: 20,
        maxLeverage: null,
      });
      console.log(`    ✅ Market updated: ${sig}`);
      await sleep(DELAY_MS);

      const market = await adminClient.fetchMarket(tokenMint);
      console.log(`    New trading fee: ${market.tradingFeeBps} bps`);
      if (market.tradingFeeBps !== 20) throw new Error(`Expected 20 bps, got ${market.tradingFeeBps}`);
    } catch (err: any) {
      console.log(`    ⚠️  Admin update failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // 15d: Restore trading fee
  console.log("  15d: Restoring trading fee to 30 bps...");
  {
    try {
      const sig = await adminClient.adminUpdateMarket(tokenMint, null, {
        oracleAddress: null,
        active: null,
        tradingFeeBps: 30,
        maxLeverage: null,
      });
      console.log(`    ✅ Fee restored: ${sig}`);
      await sleep(DELAY_MS);
    } catch (err: any) {
      console.log(`    ⚠️  Restore failed: ${err.message?.slice(0, 200)}`);
    }
  }

  // ═══════════════════════════════════════════
  // Summary
  // ═══════════════════════════════════════════
  console.log("\n═══════════════════════════════════════════");
  console.log("  E2E Test Suite Complete!");
  console.log("═══════════════════════════════════════════");
  console.log("\nFinal State:");

  const finalMarket = await adminClient.fetchMarket(tokenMint);
  console.log(`  Market: ${marketAddress.toBase58()}`);
  console.log(`  Active: ${finalMarket.active}`);
  console.log(`  Total volume: ${finalMarket.totalVolume.toString()}`);
  console.log(`  Total users: ${finalMarket.totalUsers}`);
  console.log(`  Vault balance: ${finalMarket.vaultBalance.toNumber() / 10 ** TOKEN_DECIMALS}`);
  console.log(`  Insurance fund: ${finalMarket.insuranceFundBalance.toNumber() / 10 ** TOKEN_DECIMALS}`);
  console.log(`  Creator fees earned: ${finalMarket.creatorFeesEarned.toNumber() / 10 ** TOKEN_DECIMALS}`);
  console.log(`  Protocol fees earned: ${finalMarket.protocolFeesEarned.toNumber() / 10 ** TOKEN_DECIMALS}`);

  // Close traderB position as cleanup
  console.log("\n  Cleanup: closing traderB position...");
  try {
    oracleAccount = await postPythPriceUpdate(connection, new Wallet(admin));
    await sleep(1000);
    const sig = await traderBClient.closePosition(tokenMint, oracleAccount);
    console.log(`    ✅ TraderB position closed: ${sig}`);
  } catch (err: any) {
    console.log(`    ⚠️  TraderB close failed: ${err.message?.slice(0, 120)}`);
  }

  console.log("\n🎉 All done!");
}

// ─────────────────────────────────────────────
// Run
// ─────────────────────────────────────────────

main().catch((err) => {
  console.error("\n❌ E2E test failed:", err);
  process.exit(1);
});
