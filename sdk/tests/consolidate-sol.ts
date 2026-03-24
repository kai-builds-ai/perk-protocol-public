/**
 * Pull SOL back from test wallets to admin for program deployment.
 * Leaves 0.1 SOL in each wallet for later tx fees.
 * Usage: npx ts-node tests/consolidate-sol.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const WALLET_DIR = path.join(__dirname, "wallets");
const DEVNET_URL = "https://api.devnet.solana.com";
const KEEP_AMOUNT = 0.1 * LAMPORTS_PER_SOL; // Keep 0.1 SOL per wallet
const TX_FEE = 5000; // 5000 lamports per tx

const DONORS = ["creator", "traderA", "traderB", "traderC", "cranker", "feeWallet"];

async function main() {
  const connection = new Connection(DEVNET_URL, "confirmed");

  const adminKey = Keypair.fromSecretKey(
    Uint8Array.from(JSON.parse(fs.readFileSync(path.join(WALLET_DIR, "admin.json"), "utf-8")))
  );
  const manifest = JSON.parse(fs.readFileSync(path.join(WALLET_DIR, "manifest.json"), "utf-8"));

  for (const role of DONORS) {
    const kp = Keypair.fromSecretKey(
      Uint8Array.from(JSON.parse(fs.readFileSync(path.join(WALLET_DIR, `${role}.json`), "utf-8")))
    );
    const balance = await connection.getBalance(kp.publicKey);
    const sendAmount = balance - KEEP_AMOUNT - TX_FEE;
    
    if (sendAmount <= 0) {
      console.log(`  ${role}: only ${balance / LAMPORTS_PER_SOL} SOL, skipping`);
      continue;
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: kp.publicKey,
        toPubkey: adminKey.publicKey,
        lamports: sendAmount,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
    console.log(`  ${role}: sent ${(sendAmount / LAMPORTS_PER_SOL).toFixed(4)} SOL back to admin (${sig.slice(0, 16)}...)`);
  }

  const finalBalance = await connection.getBalance(adminKey.publicKey);
  console.log(`\nAdmin balance: ${finalBalance / LAMPORTS_PER_SOL} SOL`);
}

main().catch(console.error);
