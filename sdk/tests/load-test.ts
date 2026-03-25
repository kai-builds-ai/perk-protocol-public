/**
 * Perk Protocol — Concurrent Load Test (Solana Devnet)
 * 
 * Fires multiple traders simultaneously: deposits, opens, closes, withdrawals.
 * Tests that the program handles concurrent access correctly.
 */

import {
  Connection,
  Keypair,
  PublicKey,
} from "@solana/web3.js";
import { Wallet, BN } from "@coral-xyz/anchor";
import { PythSolanaReceiver } from "@pythnetwork/pyth-solana-receiver";
import { PerkClient } from "../src/client";
import { Side } from "../src/types";
import { PERK_PROGRAM_ID, LEVERAGE_SCALE, PRICE_SCALE } from "../src/constants";
import * as fs from "fs";
import * as path from "path";

// ── Config ──

const RPC_URL = "https://api.devnet.solana.com";
const SOL_USD_FEED_HEX = "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d";
const HERMES_URL = "https://hermes.pyth.network";
const TOKEN_DECIMALS = 6;
const ROUNDS = 5;
const DEPOSIT_AMOUNT = 50; // tokens per round per trader
const LEVERAGE = 3;
const BASE_SIZE = 100_000; // small position size to avoid margin issues

// ── Helpers ──

function loadKeypair(name: string): Keypair {
  const filePath = path.join(__dirname, "wallets", `${name}.json`);
  const raw = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  return Keypair.fromSecretKey(Uint8Array.from(raw));
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchHermesVaa(feedId: string): Promise<string[]> {
  const url = `${HERMES_URL}/v2/updates/price/latest?ids[]=${feedId}&encoding=base64`;
  const resp = await fetch(url);
  if (!resp.ok) throw new Error(`Hermes fetch failed: ${resp.status}`);
  const data = await resp.json() as any;
  return data.binary.data;
}

// Singleton Pyth receiver
let _pythReceiver: PythSolanaReceiver | null = null;
function getPythReceiver(connection: Connection, wallet: Wallet): PythSolanaReceiver {
  if (!_pythReceiver) {
    _pythReceiver = new PythSolanaReceiver({ connection, wallet });
  }
  return _pythReceiver;
}

function getOracleAddress(connection: Connection, wallet: Wallet): PublicKey {
  return getPythReceiver(connection, wallet).getPriceFeedAccountAddress(0, SOL_USD_FEED_HEX);
}

async function postPythPriceUpdate(connection: Connection, wallet: Wallet): Promise<PublicKey> {
  const psr = getPythReceiver(connection, wallet);
  const vaas = await fetchHermesVaa(SOL_USD_FEED_HEX);
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

// ── Stats ──

const stats = {
  deposits: { ok: 0, fail: 0 },
  opens: { ok: 0, fail: 0 },
  closes: { ok: 0, fail: 0 },
  withdrawals: { ok: 0, fail: 0 },
  oracles: { ok: 0, fail: 0 },
};

// ── Main ──

async function main() {
  const connection = new Connection(RPC_URL, "confirmed");
  const admin = loadKeypair("admin");
  const adminWallet = new Wallet(admin);
  
  const traderA = loadKeypair("traderA");
  const traderB = loadKeypair("traderB");
  const traderC = loadKeypair("traderC");
  
  const state = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets", "test-state.json"), "utf-8"));
  const tokenMint = new PublicKey(state.tokenMint);
  
  const adminClient = new PerkClient({ connection, wallet: adminWallet, commitment: "confirmed" });
  const clients = [
    { name: "traderA", kp: traderA, client: new PerkClient({ connection, wallet: new Wallet(traderA), commitment: "confirmed" }), side: Side.Long },
    { name: "traderB", kp: traderB, client: new PerkClient({ connection, wallet: new Wallet(traderB), commitment: "confirmed" }), side: Side.Short },
    { name: "traderC", kp: traderC, client: new PerkClient({ connection, wallet: new Wallet(traderC), commitment: "confirmed" }), side: Side.Long },
  ];
  
  const [marketAddress] = PublicKey.findProgramAddressSync(
    [Buffer.from("market"), tokenMint.toBuffer()],
    PERK_PROGRAM_ID,
  );
  
  const oracle = getOracleAddress(connection, adminWallet);
  
  console.log("═══════════════════════════════════════════");
  console.log("  Perk Protocol — Concurrent Load Test");
  console.log("═══════════════════════════════════════════");
  console.log(`  Market: ${marketAddress.toBase58()}`);
  console.log(`  Oracle: ${oracle.toBase58()}`);
  console.log(`  Rounds: ${ROUNDS}`);
  console.log(`  Traders: ${clients.map(c => c.name).join(", ")}`);
  console.log("");
  
  for (let round = 1; round <= ROUNDS; round++) {
    console.log(`\n── Round ${round}/${ROUNDS} ──`);
    const t0 = Date.now();
    
    // Fresh oracle
    try {
      await postPythPriceUpdate(connection, adminWallet);
      stats.oracles.ok++;
      console.log("  ✅ Oracle refreshed");
    } catch (err: any) {
      stats.oracles.fail++;
      console.log(`  ❌ Oracle: ${err.message?.slice(0, 80)}`);
      await sleep(3000);
      continue;
    }
    await sleep(2000);
    
    // Concurrent deposits
    console.log("  Depositing...");
    const depResults = await Promise.allSettled(
      clients.map(({ name, client }) =>
        client.deposit(tokenMint, oracle, new BN(DEPOSIT_AMOUNT * 10 ** TOKEN_DECIMALS))
          .then(sig => ({ name, sig }))
      )
    );
    for (const r of depResults) {
      if (r.status === "fulfilled") { stats.deposits.ok++; console.log(`    ✅ ${r.value.name}`); }
      else { stats.deposits.fail++; console.log(`    ❌ ${(r.reason as any)?.message?.slice(0, 80)}`); }
    }
    await sleep(2000);
    
    // Fresh oracle for opens
    try {
      await postPythPriceUpdate(connection, adminWallet);
      stats.oracles.ok++;
    } catch { stats.oracles.fail++; continue; }
    await sleep(2000);
    
    // Concurrent opens
    console.log("  Opening positions...");
    const openResults = await Promise.allSettled(
      clients.map(({ name, client, side }) =>
        client.openPosition(tokenMint, oracle, side, new BN(BASE_SIZE), LEVERAGE * LEVERAGE_SCALE, 500)
          .then(sig => ({ name, sig }))
      )
    );
    for (const r of openResults) {
      if (r.status === "fulfilled") { stats.opens.ok++; console.log(`    ✅ ${r.value.name}`); }
      else { stats.opens.fail++; console.log(`    ❌ ${(r.reason as any)?.message?.slice(0, 100)}`); }
    }
    await sleep(3000);
    
    // Fresh oracle for closes
    try {
      await postPythPriceUpdate(connection, adminWallet);
      stats.oracles.ok++;
    } catch { stats.oracles.fail++; continue; }
    await sleep(2000);
    
    // Concurrent closes
    console.log("  Closing positions...");
    const closeResults = await Promise.allSettled(
      clients.map(({ name, client }) =>
        client.closePosition(tokenMint, oracle)
          .then(sig => ({ name, sig }))
      )
    );
    for (const r of closeResults) {
      if (r.status === "fulfilled") { stats.closes.ok++; console.log(`    ✅ ${r.value.name}`); }
      else { stats.closes.fail++; console.log(`    ❌ ${(r.reason as any)?.message?.slice(0, 100)}`); }
    }
    await sleep(2000);
    
    // Fresh oracle for withdrawals
    try {
      await postPythPriceUpdate(connection, adminWallet);
      stats.oracles.ok++;
    } catch { stats.oracles.fail++; continue; }
    await sleep(2000);
    
    // Concurrent withdrawals (small amount)
    console.log("  Withdrawing...");
    const wdResults = await Promise.allSettled(
      clients.map(({ name, client }) =>
        client.withdraw(tokenMint, oracle, new BN(10 * 10 ** TOKEN_DECIMALS))
          .then(sig => ({ name, sig }))
      )
    );
    for (const r of wdResults) {
      if (r.status === "fulfilled") { stats.withdrawals.ok++; console.log(`    ✅ ${r.value.name}`); }
      else { stats.withdrawals.fail++; console.log(`    ❌ ${(r.reason as any)?.message?.slice(0, 100)}`); }
    }
    
    console.log(`  Round ${round} done in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
    await sleep(2000);
  }
  
  // Summary
  console.log("\n═══════════════════════════════════════════");
  console.log("  Load Test Results");
  console.log("═══════════════════════════════════════════");
  console.log(`  Oracles:     ${stats.oracles.ok} ok / ${stats.oracles.fail} fail`);
  console.log(`  Deposits:    ${stats.deposits.ok} ok / ${stats.deposits.fail} fail`);
  console.log(`  Opens:       ${stats.opens.ok} ok / ${stats.opens.fail} fail`);
  console.log(`  Closes:      ${stats.closes.ok} ok / ${stats.closes.fail} fail`);
  console.log(`  Withdrawals: ${stats.withdrawals.ok} ok / ${stats.withdrawals.fail} fail`);
  const total = stats.deposits.ok + stats.deposits.fail + stats.opens.ok + stats.opens.fail +
    stats.closes.ok + stats.closes.fail + stats.withdrawals.ok + stats.withdrawals.fail;
  const fails = stats.deposits.fail + stats.opens.fail + stats.closes.fail + stats.withdrawals.fail;
  console.log(`\n  Total: ${total} ops | ${fails} failures | ${(((total - fails) / Math.max(total, 1)) * 100).toFixed(1)}% success`);
  
  const market = await adminClient.fetchMarket(tokenMint);
  console.log(`\n  Vault: ${market.vaultBalance.toNumber() / 1e6} | Volume: ${market.totalVolume.toString()} | Insurance: ${market.insuranceFundBalance.toNumber() / 1e6}`);
  console.log("\n🏁 Done!");
}

main().catch((err) => {
  console.error("\n❌ Failed:", err);
  process.exit(1);
});
