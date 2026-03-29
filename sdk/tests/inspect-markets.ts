import { Connection, PublicKey } from "@solana/web3.js";
import { Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { PerkClient } from "../src";

const PROGRAM_ID = "3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2";
const RPC = process.env.PERK_RPC_URL!;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const WSOL_MINT = "So11111111111111111111111111111111111111112";

async function main() {
  const connection = new Connection(RPC, "confirmed");
  const dummy = new Wallet(Keypair.generate());
  const client = new PerkClient({ connection, wallet: dummy, programId: new PublicKey(PROGRAM_ID) });

  const markets = await client.fetchAllMarkets();
  console.log(`Found ${markets.length} markets\n`);

  for (const { address, account } of markets) {
    const collMint = account.collateralMint.toBase58();
    const tokenMint = account.tokenMint.toBase58();
    const isUSDC = collMint === USDC_MINT;
    const isWSOL = collMint === WSOL_MINT;

    // Check vault mint matches
    const vaultAddr = client.getVaultAddress(address);
    let vaultMintStr = "?";
    try {
      const vaultInfo = await connection.getParsedAccountInfo(vaultAddr);
      if (vaultInfo.value?.data && "parsed" in vaultInfo.value.data) {
        vaultMintStr = vaultInfo.value.data.parsed.info.mint;
      }
    } catch {}

    const mismatch = vaultMintStr !== collMint;

    console.log(`Market: ${address.toBase58()}`);
    console.log(`  Token:      ${tokenMint.slice(0, 12)}...`);
    console.log(`  Collateral: ${collMint.slice(0, 12)}... (${isUSDC ? "USDC" : isWSOL ? "WSOL" : "OTHER"})`);
    console.log(`  Vault mint: ${vaultMintStr.slice(0, 12)}...`);
    console.log(`  Active:     ${account.active}`);
    if (mismatch) console.log(`  ⚠️  MINT MISMATCH! Vault mint ≠ collateral mint`);
    console.log();
  }
}

main().catch(console.error);
