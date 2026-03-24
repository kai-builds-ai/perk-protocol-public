/**
 * Generate devnet test wallets for Perk protocol E2E testing.
 * 
 * Roles:
 *   - admin:      Protocol initializer, can pause/update markets
 *   - creator:    Market creator (creates perp markets)
 *   - traderA:    Opens long positions, places trigger orders
 *   - traderB:    Opens short positions (counterparty for traderA)
 *   - traderC:    Under-collateralized trader (gets liquidated)
 *   - cranker:    Runs the cranker (funding, peg, liquidations, trigger orders)
 *   - feeWallet:  Protocol fee vault owner
 * 
 * Outputs keypairs as JSON to tests/wallets/
 * Each file is a standard Solana CLI keypair (JSON array of bytes).
 * 
 * Usage: npx ts-node tests/generate-wallets.ts
 */

import { Keypair } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const WALLET_DIR = path.join(__dirname, "wallets");
const ROLES = [
  "admin",
  "creator",
  "traderA",
  "traderB",
  "traderC",
  "cranker",
  "feeWallet",
] as const;

function main() {
  if (!fs.existsSync(WALLET_DIR)) {
    fs.mkdirSync(WALLET_DIR, { recursive: true });
  }

  const manifest: Record<string, string> = {};

  for (const role of ROLES) {
    const filePath = path.join(WALLET_DIR, `${role}.json`);

    // Don't overwrite existing wallets (they may have devnet SOL)
    if (fs.existsSync(filePath)) {
      const existing = Keypair.fromSecretKey(
        Uint8Array.from(JSON.parse(fs.readFileSync(filePath, "utf-8")))
      );
      manifest[role] = existing.publicKey.toBase58();
      console.log(`  ${role}: ${existing.publicKey.toBase58()} (existing)`);
      continue;
    }

    const kp = Keypair.generate();
    fs.writeFileSync(filePath, JSON.stringify(Array.from(kp.secretKey)));
    manifest[role] = kp.publicKey.toBase58();
    console.log(`  ${role}: ${kp.publicKey.toBase58()} (new)`);
  }

  // Write manifest for easy lookup
  fs.writeFileSync(
    path.join(WALLET_DIR, "manifest.json"),
    JSON.stringify(manifest, null, 2)
  );
  console.log(`\nManifest written to ${path.join(WALLET_DIR, "manifest.json")}`);
  console.log(`\nNext: airdrop devnet SOL to each wallet:`);
  for (const [role, pubkey] of Object.entries(manifest)) {
    console.log(`  solana airdrop 2 ${pubkey} --url devnet`);
  }
}

main();
