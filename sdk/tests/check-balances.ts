import { Connection, Keypair, LAMPORTS_PER_SOL } from "@solana/web3.js";
import * as fs from "fs";
import * as path from "path";

const RPC_URL = "https://api.devnet.solana.com";
const conn = new Connection(RPC_URL, "confirmed");
const names = ["admin", "traderA", "traderB", "traderC", "cranker", "creator"];

async function main() {
  for (const n of names) {
    const raw = JSON.parse(fs.readFileSync(path.join(__dirname, "wallets", `${n}.json`), "utf-8"));
    const kp = Keypair.fromSecretKey(Uint8Array.from(raw));
    const bal = await conn.getBalance(kp.publicKey);
    console.log(`${n}: ${kp.publicKey.toBase58()} — ${(bal / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
  }
}

main().catch(console.error);
