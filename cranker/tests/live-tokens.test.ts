import { fetchPrice, fetchPricesBatch } from "../feeds";

const tokens: Record<string, string> = {
  VNUT: "CR8w8WPtu1eeHj3UTTNYXVe8WX81iT1JexvLemTrpump",
  CAPTCHA: "FtSRgyCEhKTc1PPgEAXvuHN3NyiP6LS9uyB28KCN3CAP",
  APES: "ChNrhBZwGtn1ZRsrdzcuBqiKTYfVViCPZqJdsgBHpump",
  SOL: "So11111111111111111111111111111111111111112",
};

const jupKey = process.env.JUPITER_API_KEY;
const birdKey = process.env.BIRDEYE_API_KEY;

async function main() {
  console.log("Jupiter key:", jupKey ? "✅ set" : "❌ missing");
  console.log("Birdeye key:", birdKey ? "✅ set" : "❌ missing");

  // --- Single token fetch (SOL, require both sources) ---
  console.log("\n=== Single Token: SOL ===");
  try {
    const sol = await fetchPrice(tokens.SOL, birdKey, 2, 0.05, jupKey);
    console.log(`✅ SOL: $${(sol.price.toNumber() / 1e6).toFixed(2)} | sources=${sol.numSources} | confidence=${sol.confidence.toString()}`);
    console.log(`   Sources: ${sol.sources.map((s) => `${s.name}=$${s.price}`).join(", ")}`);
  } catch (e: any) {
    console.error(`❌ SOL failed: ${e.message}`);
  }

  // --- Batch fetch (your 3 picks + SOL) ---
  console.log("\n=== Batch Fetch: Your Picks ===");
  const mints = Object.values(tokens);
  try {
    // Use minSources=1 for memecoins — they might not be on both sources
    const batch = await fetchPricesBatch(mints, birdKey, 1, 0.10, jupKey);
    for (const [name, mint] of Object.entries(tokens)) {
      const p = batch.get(mint);
      if (p) {
        const usd = p.price.toNumber() / 1e6;
        const conf = p.confidence.toNumber() / 1e6;
        console.log(`✅ ${name}: $${usd < 0.01 ? usd.toFixed(8) : usd.toFixed(4)} | sources=${p.numSources} | confidence=$${conf.toFixed(8)}`);
        console.log(`   Sources: ${p.sources.map((s) => `${s.name}=$${s.price}`).join(", ")}`);
      } else {
        console.log(`⚠️  ${name}: NO PRICE`);
      }
    }
    console.log(`\nTotal: ${batch.size}/${mints.length} tokens priced`);
  } catch (e: any) {
    console.error(`❌ Batch failed: ${e.message}`);
  }

  // --- Batch with minSources=2 (strict) ---
  console.log("\n=== Strict Mode (require both sources) ===");
  try {
    const strict = await fetchPricesBatch(mints, birdKey, 2, 0.05, jupKey);
    for (const [name, mint] of Object.entries(tokens)) {
      const p = strict.get(mint);
      if (p) {
        const usd = p.price.toNumber() / 1e6;
        console.log(`✅ ${name}: $${usd < 0.01 ? usd.toFixed(8) : usd.toFixed(4)} (2 sources, <5% divergence)`);
      } else {
        console.log(`⚠️  ${name}: SKIPPED (insufficient sources or divergence > 5%)`);
      }
    }
  } catch (e: any) {
    console.error(`❌ Strict batch failed: ${e.message}`);
  }
}

main().then(() => console.log("\nDone."));
