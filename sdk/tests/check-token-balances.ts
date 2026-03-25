import { Connection, Keypair, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { getAssociatedTokenAddress, getAccount } from "@solana/spl-token";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = "https://api.devnet.solana.com";
const conn = new Connection(RPC_URL, "confirmed");
const names = ["admin", "traderA", "traderB", "traderC", "cranker", "creator"];

// Read token mint from state
const state = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets", "test-state.json"), "utf-8"));
const tokenMint = new PublicKey(state.tokenMint);

async function main() {
  console.log(`Token mint: ${tokenMint.toBase58()}\n`);
  for (const n of names) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets", `${n}.json`), "utf-8"));
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    const sol = await conn.getBalance(kp.publicKey);
    const ata = await getAssociatedTokenAddress(tokenMint, kp.publicKey);
    let tokenBal = 0;
    try {
      const acct = await getAccount(conn, ata);
      tokenBal = Number(acct.amount) / 1e6;
    } catch {}
    console.log(`${n.padEnd(10)} ${kp.publicKey.toBase58()}  SOL: ${(sol / LAMPORTS_PER_SOL).toFixed(4)}  Tokens: ${tokenBal.toFixed(2)}`);
  }
}

main().catch(console.error);
