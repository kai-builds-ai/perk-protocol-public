const { Connection, PublicKey } = require("@solana/web3.js");

(async () => {
  const conn = new Connection(process.env.PERK_RPC_URL || (() => { throw new Error("PERK_RPC_URL not set") })());
  const PROGRAM = new PublicKey("3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2");
  const CRANKER = "99mUUwVBvCD1pLP7fk5z7xPuBoGpyuUGpyTBhW53yw99";
  
  const accounts = await conn.getProgramAccounts(PROGRAM, {
    filters: [{ dataSize: 200 }]
  });
  
  console.log("PerkOracle accounts:", accounts.length);
  let wrong = 0, correct = 0;
  
  for (const { pubkey, account } of accounts) {
    const data = account.data;
    // 8 disc + 1 bump + 32 token_mint + 32 authority
    const offset = 8 + 1; // skip discriminator + bump
    const mint = new PublicKey(data.subarray(offset, offset + 32));
    const authority = new PublicKey(data.subarray(offset + 32, offset + 64));
    const price = data.readBigUInt64LE(offset + 64);
    const timestamp = Number(data.readBigInt64LE(offset + 64 + 8 + 8)); // price + confidence + timestamp
    
    const isCorrect = authority.toBase58() === CRANKER;
    if (!isCorrect) wrong++;
    else correct++;
    
    console.log(
      isCorrect ? "OK" : "WRONG",
      "mint:", mint.toBase58().slice(0, 8) + "...",
      "auth:", authority.toBase58().slice(0, 8) + "...",
      "price:", price.toString(),
      "ts:", timestamp
    );
  }
  console.log("\nCorrect:", correct, "Wrong:", wrong);
})();
