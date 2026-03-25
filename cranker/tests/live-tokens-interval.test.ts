import { fetchPrice, fetchPricesBatch } from "../feeds";

const tokens: Record<string, string> = {
  VNUT: "CR8w8WPtu1eeHj3UTTNYXVe8WX81iT1JexvLemTrpump",
  CAPTCHA: "FtSRgyCEhKTc1PPgEAXvuHN3NyiP6LS9uyB28KCN3CAP",
  APES: "ChNrhBZwGtn1ZRsrdzcuBqiKTYfVViCPZqJdsgBHpump",
  SOL: "So11111111111111111111111111111111111111112",
};

const jupKey = process.env.JUPITER_API_KEY;
const birdKey = process.env.BIRDEYE_API_KEY;
const mints = Object.values(tokens);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tick(round: number): Promise<void> {
  console.log(`\n========== TICK ${round} (${new Date().toISOString()}) ==========`);
  try {
    const batch = await fetchPricesBatch(mints, birdKey, 2, 0.10, jupKey);
    for (const [name, mint] of Object.entries(tokens)) {
      const p = batch.get(mint);
      if (p) {
        const usd = p.price.toNumber() / 1e6;
        console.log(
          `✅ ${name.padEnd(8)}: $${usd < 0.01 ? usd.toFixed(8) : usd.toFixed(4)} | sources=${p.numSources} | ${p.sources.map((s) => s.name).join("+")}`,
        );
      } else {
        console.log(`⚠️  ${name.padEnd(8)}: SKIPPED (insufficient sources or divergence)`);
      }
    }
    console.log(`Total: ${batch.size}/${mints.length} priced`);
  } catch (e: any) {
    console.error(`❌ Batch failed: ${e.message}`);
  }
}

async function main() {
  console.log("Jupiter key:", jupKey ? "✅" : "❌");
  console.log("Birdeye key:", birdKey ? "✅" : "❌");
  console.log("Running 3 ticks with 10s intervals (minSources=2, maxDivergence=10%)...");

  for (let i = 1; i <= 3; i++) {
    await tick(i);
    if (i < 3) {
      console.log(`\n⏳ Waiting 10 seconds...`);
      await sleep(10_000);
    }
  }
  console.log("\n✅ Done.");
}

main();
