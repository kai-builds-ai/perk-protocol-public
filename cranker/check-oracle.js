const { Connection, PublicKey } = require("@solana/web3.js");
const { PerkClient } = require("./sdk-dist");

(async () => {
  const conn = new Connection("https://mainnet.helius-rpc.com/?api-key=01c862fa-ae04-4c0d-92bf-4d547db44c88");
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  
  // Derive PerkOracle PDA
  const [oracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("perk_oracle"), SOL_MINT.toBuffer()],
    new PublicKey("3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2")
  );
  console.log("SOL PerkOracle:", oracle.toBase58());
  
  const info = await conn.getAccountInfo(oracle);
  if (!info) { console.log("NOT FOUND"); return; }
  
  // PerkOraclePrice layout after 8-byte discriminator:
  // token_mint: 32, oracle_authority: 32, price: 8 (i64), confidence: 8 (u64),
  // num_sources: 1 (u8), last_update: 8 (i64)
  const data = info.data;
  const lastUpdate = Number(data.readBigInt64LE(8 + 32 + 32 + 8 + 8 + 1));
  const price = Number(data.readBigInt64LE(8 + 32 + 32));
  const slot = await conn.getSlot();
  const blockTime = await conn.getBlockTime(slot);
  const age = blockTime - lastUpdate;
  console.log("Last update:", lastUpdate, "(" + new Date(lastUpdate * 1000).toISOString() + ")");
  console.log("Current time:", blockTime);
  console.log("Age:", age, "seconds");
  console.log("Price (raw):", price);
  console.log("Stale?", age > 120 ? "YES" : "NO");
})();
