const { Connection, PublicKey } = require("@solana/web3.js");

(async () => {
  const conn = new Connection(process.env.PERK_RPC_URL || (() => { throw new Error("PERK_RPC_URL not set") })());
  const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");
  const CRANKER = "99mUUwVBvCD1pLP7fk5z7xPuBoGpyuUGpyTBhW53yw99";
  
  const [oracle] = PublicKey.findProgramAddressSync(
    [Buffer.from("perk_oracle"), SOL_MINT.toBuffer()],
    new PublicKey("3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2")
  );
  
  const info = await conn.getAccountInfo(oracle);
  const data = info.data;
  // After 8-byte discriminator: token_mint (32), oracle_authority (32)
  const authority = new PublicKey(data.subarray(8 + 32, 8 + 32 + 32));
  console.log("Oracle authority:", authority.toBase58());
  console.log("Cranker pubkey:", CRANKER);
  console.log("Match:", authority.toBase58() === CRANKER);
})();
