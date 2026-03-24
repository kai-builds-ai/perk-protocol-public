/**
 * Distribute devnet SOL from admin wallet to all test wallets.
 * Usage: npx ts-node tests/distribute-sol.ts
 */

import {
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  PublicKey,
} from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const WALLET_DIR = path.join(__dirname, "wallets");
const DEVNET_URL = "https://api.devnet.solana.com";
const AMOUNT_PER_WALLET = 1.5 * LAMPORTS_PER_SOL;

const RECIPIENTS = ["creator", "traderA", "traderB", "traderC", "cranker", "feeWallet"];

async function main() {
  const connection = new Connection(DEVNET_URL, "confirmed");

  // Load admin keypair
  const adminKey = Keypair.fromSecretKey(
    Uint8Array.from(
      JSON.parse(fs.readFileSync(path.join(WALLET_DIR, "admin.json"), "utf-8"))
    )
  );
  console.log(`Admin: ${adminKey.publicKey.toBase58()}`);

  const balance = await connection.getBalance(adminKey.publicKey);
  console.log(`Admin balance: ${balance / LAMPORTS_PER_SOL} SOL`);

  const totalNeeded = RECIPIENTS.length * AMOUNT_PER_WALLET;
  if (balance < totalNeeded + 0.1 * LAMPORTS_PER_SOL) {
    console.error(`Need ${totalNeeded / LAMPORTS_PER_SOL} SOL + fees, have ${balance / LAMPORTS_PER_SOL}`);
    process.exit(1);
  }

  // Send to each recipient (one tx each to avoid size limits)
  for (const role of RECIPIENTS) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(WALLET_DIR, "manifest.json"), "utf-8")
    );
    const recipient = new PublicKey(manifest[role]);

    // Check if already funded
    const existing = await connection.getBalance(recipient);
    if (existing >= AMOUNT_PER_WALLET * 0.9) {
      console.log(`  ${role}: already has ${existing / LAMPORTS_PER_SOL} SOL, skipping`);
      continue;
    }

    const tx = new Transaction().add(
      SystemProgram.transfer({
        fromPubkey: adminKey.publicKey,
        toPubkey: recipient,
        lamports: AMOUNT_PER_WALLET,
      })
    );

    const sig = await sendAndConfirmTransaction(connection, tx, [adminKey]);
    console.log(`  ${role}: sent 1.5 SOL → ${recipient.toBase58().slice(0, 8)}... (${sig.slice(0, 16)}...)`);
  }

  // Final balances
  console.log("\nFinal balances:");
  const allRoles = ["admin", ...RECIPIENTS];
  for (const role of allRoles) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(WALLET_DIR, "manifest.json"), "utf-8")
    );
    const bal = await connection.getBalance(new PublicKey(manifest[role]));
    console.log(`  ${role}: ${bal / LAMPORTS_PER_SOL} SOL`);
  }
}

main().catch(console.error);
