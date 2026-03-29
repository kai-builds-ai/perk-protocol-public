# Perk Security Notes

## Oracle — #1 Attack Surface

Price oracle manipulation is the most common DeFi exploit vector. Every major perp DEX hack traces back to oracle issues.

### Known Oracle Attack Patterns (must defend against ALL)
1. **Flash loan → pump DEX pool → read manipulated price → profit** — classic. Our DEX oracle (PumpSwap/Raydium) is especially vulnerable to this.
2. **Stale price exploitation** — oracle stops updating, attacker trades at stale favorable price.
3. **Oracle sandwich** — manipulate price before and after a user's liquidation to profit from it.
4. **Confidence interval abuse** — Pyth reports confidence bands. Low confidence = unreliable price. Must reject.
5. **Multi-block oracle manipulation** — attacker controls multiple blocks (MEV), sustains manipulated price across our staleness window.
6. **TWAP manipulation** — if we use TWAP, attacker needs to sustain manipulation longer but it's still possible on low-liquidity pools.

### Our Defenses (verify all are implemented)
- [ ] Pyth staleness check (reject > 30 seconds old)
- [ ] Pyth confidence check (reject if confidence > 2% of price)
- [ ] DEX pool minimum liquidity threshold (reject thin pools)
- [ ] DEX pool TWAP (not spot price) — harder to manipulate
- [ ] **Warmup window** — Percolator's key defense. Profit doesn't mature instantly, so flash-manipulation profit sits locked in `reserved_pnl` until warmup elapses. Attacker can't withdraw.
- [ ] vAMM peg drift threshold — if mark price diverges > X% from oracle, halt trading
- [ ] Funding rate cap — limits economic damage from sustained oracle divergence
- [ ] Per-market circuit breaker — if price moves > Y% in Z seconds, pause the market

### DEX Oracle Specific Risks (our biggest weakness)
For memecoins using PumpSwap/Raydium pool prices:
- Pool liquidity can be thin — easier to manipulate
- No confidence interval like Pyth — we have to build our own validation
- Flash loans can move the pool price within a single transaction
- **Mitigation:** require minimum pool liquidity at market creation time, use TWAP not spot, consider requiring Pyth for any market above a certain OI threshold

### Red Team Must Test
- [ ] Can an attacker flash-manipulate the DEX pool and profit before warmup kicks in?
- [ ] Can an attacker liquidate someone using a manipulated oracle price?
- [ ] What happens if Pyth goes down for 5 minutes?
- [ ] What happens if a DEX pool gets rugged (liquidity removed)?
- [ ] Can the vAMM peg update be used to create an arbitrage that drains the vault?

### Rule: When in doubt, halt.
Better to pause a market and have angry traders than lose the vault. Markets can resume. Stolen funds can't.
