"use client";

import React, { useState } from "react";
import Link from "next/link";
import { useMarkets } from "@/hooks/useMarkets";
import { formatUsdCompact } from "@/lib/format";
import { TokenLogo } from "@/components/TokenLogo";

function useStats() {
  const { markets } = useMarkets();
  return {
    totalVolume: markets.reduce((s, m) => s + m.volume24h, 0),
    totalOI: markets.reduce((s, m) => s + m.openInterest, 0),
    totalMarkets: markets.length,
    totalTraders: markets.reduce((s, m) => s + m.totalUsers, 0),
  };
}

function LandingNav() {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <nav className="border-b border-border relative sticky top-0 z-50 bg-bg">
      <div className="flex items-center justify-between px-4 md:px-8 h-14 max-w-7xl mx-auto">
        <div className="flex items-center gap-6 md:gap-10">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-[4px] overflow-hidden bg-bg flex-shrink-0"><img src="/logo.png" alt="Perk" width={36} height={36} className="mix-blend-lighten" /></div>
            <span className="font-sans font-semibold text-base text-white tracking-[0.25em]">PERK</span>
          </div>
          <div className="hidden md:flex items-center gap-6 ml-4">
            <Link href="/markets" className="text-sm text-text-secondary hover:text-white transition-colors duration-100 font-sans">Markets</Link>
            <Link href="/launch" className="text-sm text-text-secondary hover:text-white transition-colors duration-100 font-sans">Create Market</Link>
            <a href="https://docs.perk.fund" className="text-sm text-text-secondary hover:text-white transition-colors duration-100 font-sans">Docs</a>
            <a href="https://github.com/kai-builds-ai/perk-protocol-public" className="text-sm text-text-secondary hover:text-white transition-colors duration-100 font-sans">GitHub</a>
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/markets" className="text-sm font-sans font-medium border border-white/80 text-white px-5 py-2 hover:bg-white/10 rounded-[4px] transition-colors duration-100 hidden sm:inline-block">
            Launch App
          </Link>
          <button onClick={() => setMenuOpen((v) => !v)} className="md:hidden flex items-center justify-center w-10 h-10 flex-shrink-0" aria-label="Toggle menu">
            {menuOpen ? (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round"><line x1="4" y1="4" x2="16" y2="16"/><line x1="16" y1="4" x2="4" y2="16"/></svg>
            ) : (
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="white" strokeWidth="1.5" strokeLinecap="round"><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/></svg>
            )}
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="absolute top-14 right-4 z-50 bg-surface border border-border rounded-md shadow-lg md:hidden w-48">
          <div className="flex flex-col items-end px-5 py-4 gap-4">
            <Link href="/markets" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Markets</Link>
            <Link href="/launch" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Create Market</Link>
            <a href="https://docs.perk.fund" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Docs</a>
            <a href="https://github.com/kai-builds-ai/perk-protocol-public" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">GitHub</a>
            <Link href="/markets" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-white sm:hidden">Launch App</Link>
          </div>
        </div>
      )}
    </nav>
  );
}

export default function Landing() {
  const stats = useStats();
  const { markets } = useMarkets();
  const topMarkets = markets.slice(0, 5);

  return (
    <div className="min-h-screen bg-bg flex flex-col">
      {/* Nav */}
      <LandingNav />

      {/* Main content — single screen, no scroll needed on 1080p+ */}
      <div className="flex-1 grid grid-rows-[1fr_auto_auto_auto] min-h-0">

        {/* Hero — compact, left-aligned with stats beside it */}
        <div className="flex items-center px-4 md:px-8 py-12 md:py-8">
          <div className="max-w-7xl w-full mx-auto grid grid-cols-1 lg:grid-cols-[1fr_1fr] gap-8 lg:gap-12 items-center">
            {/* Left: headline + CTAs */}
            <div className="space-y-6">
              <div className="space-y-3">
                <h1 className="font-sans font-semibold text-5xl leading-[1.1] text-white tracking-tight">
                  Perpetuals for<br />every token
                </h1>
                <p className="text-lg text-text-secondary font-sans leading-relaxed max-w-lg">
                  Trade any Solana token with up to 20x leverage. Create a market in one click. Earn 10% of all fees — forever.
                </p>
              </div>
              <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-3">
                <Link
                  href="/markets"
                  className="font-sans font-medium text-sm bg-white text-black px-7 py-3 rounded-[4px] hover:bg-white/90 transition-colors duration-100 text-center"
                >
                  Start Trading
                </Link>
                <Link
                  href="/launch"
                  className="font-sans font-medium text-sm border border-zinc-600 text-white px-7 py-3 rounded-[4px] hover:border-zinc-400 hover:bg-white/[0.03] transition-colors duration-100 text-center"
                >
                  Create a Market
                </Link>
              </div>
              {/* Stats inline */}
              <div className="flex flex-wrap items-center gap-x-8 gap-y-3 pt-2">
                <Stat label="Volume" value={formatUsdCompact(stats.totalVolume)} />
                <Stat label="Open Interest" value={formatUsdCompact(stats.totalOI)} />
                <Stat label="Markets" value={stats.totalMarkets.toString()} />
                <Stat label="Traders" value={stats.totalTraders.toLocaleString()} />
              </div>
            </div>

            {/* Right: live market table preview */}
            <div className="border border-border rounded-[2px] bg-surface">
              <div className="flex items-center justify-between px-4 py-3 border-b border-border">
                <span className="text-sm font-sans font-medium text-white">Top Markets</span>
                <Link href="/markets" className="text-xs font-sans text-text-secondary hover:text-white transition-colors">
                  View all →
                </Link>
              </div>
              <table className="w-full">
                <thead>
                  <tr className="border-b border-border">
                    <th className="px-4 py-2 text-left text-xs font-sans uppercase text-text-tertiary tracking-wider">Token</th>
                    <th className="px-4 py-2 text-right text-xs font-sans uppercase text-text-tertiary tracking-wider">Price</th>
                    <th className="px-4 py-2 text-right text-xs font-sans uppercase text-text-tertiary tracking-wider">24h</th>
                    <th className="px-4 py-2 text-right text-xs font-sans uppercase text-text-tertiary tracking-wider hidden md:table-cell">Vol</th>
                    <th className="px-4 py-2 text-right text-xs font-sans uppercase text-text-tertiary tracking-wider hidden md:table-cell">Lev</th>
                  </tr>
                </thead>
                <tbody>
                  {topMarkets.map((m) => (
                    <tr key={m.marketIndex} className="border-b border-border/50 hover:bg-white/[0.02] cursor-pointer transition-colors duration-75">
                      <td className="px-4 py-2.5">
                        <Link href={`/trade/${m.address}`} className="flex items-center gap-2">
                          <TokenLogo mint={m.tokenMint} logoUrl={m.logoUrl} size={20} />
                          <span className="font-sans font-medium text-white text-sm">{m.symbol}</span>
                          <span className="text-text-tertiary text-xs hidden xl:inline">{m.name}</span>
                        </Link>
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-white text-sm">
                        ${m.markPrice < 0.01 ? m.markPrice.toFixed(8) : m.markPrice.toFixed(2)}
                      </td>
                      <td className={`px-4 py-2.5 text-right font-mono text-sm ${m.change24h >= 0 ? "text-profit" : "text-loss"}`}>
                        {m.change24h >= 0 ? "+" : ""}{(m.change24h * 100).toFixed(2)}%
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-text-secondary text-sm hidden md:table-cell">
                        {formatUsdCompact(m.volume24h)}
                      </td>
                      <td className="px-4 py-2.5 text-right font-mono text-text-secondary text-sm hidden md:table-cell">
                        {m.maxLeverage}x
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>

        {/* Percolator engine — the differentiator */}
        <div className="border-t border-border px-4 md:px-8 py-12 md:py-8">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-[1fr_auto_280px] gap-8 lg:gap-10 items-start">
            <div className="space-y-3">
              <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">Risk Engine</div>
              <h2 className="font-sans font-semibold text-2xl text-white">
                Built on the Percolator
              </h2>
              <p className="text-sm text-text-secondary font-sans leading-relaxed max-w-xl">
                Full port of{" "}
                <a href="https://github.com/aeyakovenko/percolator" className="text-white underline decoration-zinc-600 hover:decoration-white transition-colors">
                  Anatoly Yakovenko&apos;s Percolator
                </a>{" "}
                risk engine — the math designed by Solana&apos;s creator for on-chain perpetual futures.
                U256 wide math, oracle-based mark-to-market, auto-deleveraging with epoch resets, insurance fund, and normative bounds on every state transition.
              </p>

            </div>
            <div className="w-px bg-border self-stretch hidden lg:block" />
            <div className="space-y-2.5 pt-1">
              <Detail label="Rust" value="7,250 lines" />
              <Detail label="Fuzz testing" value="5.9B iterations" />
              <Detail label="Verification" value="117 proofs" />
              <Detail label="Math" value="U256 / I256" />
              <Detail label="Oracle" value="Pyth + PerkOracle" />
              <Detail label="AMM" value="vAMM (x·y=k)" />
            </div>
          </div>
        </div>

        {/* How it works — three columns */}
        <div className="border-t border-border px-4 md:px-8 py-12 md:py-8">
          <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-10">
            <Step n="01" title="Trade" desc="Long or short any token with up to 20x leverage. Pyth oracle prices. Sub-second execution on Solana." />
            <Step n="02" title="Create" desc="Launch a perpetual market for any SPL token. Set leverage, fees, oracle. One transaction. One SOL." />
            <Step n="03" title="Earn" desc="Market creators earn 10% of all trading fees on their market. Forever. No lockups, no vesting." />
          </div>
        </div>

        {/* Why Perk — differentiators */}
        <div className="border-t border-border px-4 md:px-8 py-12 md:py-8">
          <div className="max-w-7xl mx-auto space-y-8">
            <div>
              <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider mb-2">Why Perk</div>
              <h2 className="font-sans font-semibold text-2xl text-white">Not another fork</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-6">
              <div className="border border-border rounded-[2px] p-5 space-y-2">
                <div className="font-mono text-sm text-white">Sub-Second Execution</div>
                <p className="text-sm text-text-secondary font-sans leading-relaxed">
                  Built natively on Solana. 400ms block times, ~$0.001 per trade. No bridges, no L2 complexity, no waiting.
                </p>
              </div>
              <div className="border border-border rounded-[2px] p-5 space-y-2">
                <div className="font-mono text-sm text-white">No Order Book</div>
                <p className="text-sm text-text-secondary font-sans leading-relaxed">
                  Pure vAMM. No market makers, no counterparty risk, no off-chain dependencies. The math is the market.
                </p>
              </div>
              <div className="border border-border rounded-[2px] p-5 space-y-2">
                <div className="font-mono text-sm text-white">Creator Revenue</div>
                <p className="text-sm text-text-secondary font-sans leading-relaxed">
                  Market creators earn 10% of all trading fees on their market. Forever. No lockups, no vesting, no cliffs.
                </p>
              </div>
              <div className="border border-border rounded-[2px] p-5 space-y-2">
                <div className="font-mono text-sm text-white">Open Source</div>
                <p className="text-sm text-text-secondary font-sans leading-relaxed">
                  Every line of code is public. MIT licensed. Audited. Formally verified. Don&apos;t trust — read the source.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* For Creators — the pitch */}
        <div className="border-t border-border px-4 md:px-8 py-12 md:py-8">
          <div className="max-w-7xl mx-auto grid grid-cols-1 lg:grid-cols-2 gap-10 items-start">
            <div className="space-y-4">
              <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider">For Creators</div>
              <h2 className="font-sans font-semibold text-2xl text-white">
                Launch a market.<br />Own the revenue.
              </h2>
              <p className="text-sm text-text-secondary font-sans leading-relaxed max-w-lg">
                See a token with no perp market? Create one. It costs 1 SOL and takes one transaction. 
                You set the leverage limits, fee tiers, and oracle configuration. From that point on, 
                you earn 10% of every trading fee generated on your market — paid directly to your wallet, every trade, forever.
              </p>
              <p className="text-sm text-text-secondary font-sans leading-relaxed max-w-lg">
                Early creators on high-volume tokens will earn the most. The meta is simple: find tokens people want to trade, create the market first.
              </p>
              <Link href="/launch" className="inline-block text-sm font-sans font-medium border border-zinc-600 text-white px-5 py-2.5 rounded-[4px] hover:border-zinc-400 hover:bg-white/[0.03] transition-colors duration-100">
                Create a Market →
              </Link>
            </div>
            <div className="border border-border rounded-[2px] bg-surface">
              <div className="px-5 py-3 border-b border-border">
                <span className="font-mono text-xs text-text-tertiary uppercase tracking-wider">Example Revenue</span>
              </div>
              <div className="px-5 py-4 space-y-3">
                <div className="flex justify-between items-center py-1.5">
                  <span className="text-sm font-sans text-text-secondary">Daily volume on your market</span>
                  <span className="text-sm font-mono text-white">$100,000</span>
                </div>
                <div className="flex justify-between items-center py-1.5">
                  <span className="text-sm font-sans text-text-secondary">Trading fee (0.1%)</span>
                  <span className="text-sm font-mono text-white">$100</span>
                </div>
                <div className="flex justify-between items-center py-1.5">
                  <span className="text-sm font-sans text-text-secondary">Your cut (10%)</span>
                  <span className="text-sm font-mono text-profit">$10 / day</span>
                </div>
                <div className="border-t border-border pt-3 flex justify-between items-center">
                  <span className="text-sm font-sans text-text-secondary">Annual passive income</span>
                  <span className="text-sm font-mono text-profit font-medium">$3,650</span>
                </div>
                <p className="text-xs text-text-tertiary font-sans pt-1">
                  Per market. No cap on how many markets you create.
                </p>
              </div>
            </div>
          </div>
        </div>

        {/* Security — credibility */}
        <div className="border-t border-border px-4 md:px-8 py-12 md:py-8">
          <div className="max-w-7xl mx-auto space-y-8">
            <div>
              <div className="font-mono text-xs text-text-tertiary uppercase tracking-wider mb-2">Security</div>
              <h2 className="font-sans font-semibold text-2xl text-white">Verified, not just audited</h2>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-6">
              <div className="border border-border rounded-[2px] p-5 space-y-3">
                <div className="font-mono text-2xl text-white">117</div>
                <div className="text-sm font-sans text-text-secondary">
                  Formal verification proofs via Kani. Every arithmetic operation, every state transition, every edge case — mathematically proven correct.
                </div>
              </div>
              <div className="border border-border rounded-[2px] p-5 space-y-3">
                <div className="font-mono text-2xl text-white">5.9B</div>
                <div className="text-sm font-sans text-text-secondary">
                  Fuzz testing iterations. Random inputs, adversarial sequences, boundary conditions. The protocol has seen more chaos than any attacker could generate.
                </div>
              </div>
              <div className="border border-border rounded-[2px] p-5 space-y-3">
                <div className="font-mono text-2xl text-white">0</div>
                <div className="text-sm font-sans text-text-secondary">
                  Critical findings remaining. Every vulnerability discovered across seven audit rounds has been resolved. Red team, invariant analysis, architecture review — all clear.
                </div>
              </div>
            </div>
            <div className="flex flex-wrap gap-4">
              <a href="https://github.com/kai-builds-ai/perk-protocol-public" target="_blank" rel="noopener noreferrer" className="text-sm font-sans text-text-secondary hover:text-white transition-colors underline decoration-zinc-700 hover:decoration-white">
                View source on GitHub →
              </a>
              <a href="https://github.com/aeyakovenko/percolator/issues/22" target="_blank" rel="noopener noreferrer" className="text-sm font-sans text-text-secondary hover:text-white transition-colors underline decoration-zinc-700 hover:decoration-white">
                Bug we found in the original Percolator →
              </a>
            </div>
          </div>
        </div>

        {/* Footer */}
        <footer className="border-t border-border px-4 md:px-8 py-5">
          <div className="max-w-7xl mx-auto flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-2">
              <div className="w-5 h-5 rounded-[2px] overflow-hidden bg-bg flex-shrink-0 opacity-60"><img src="/logo.png" alt="Perk" width={20} height={20} className="mix-blend-lighten" /></div>
              <span className="text-sm font-sans text-text-secondary tracking-wider">PERK PROTOCOL</span>
            </div>
            <div className="flex items-center gap-6">
              <a href="https://twitter.com/pabortesu" className="text-text-secondary hover:text-white transition-colors" aria-label="X">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z"/></svg>
              </a>
              <a href="https://docs.perk.fund" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Docs</a>
              <a href="mailto:contact@perk.fund" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Contact</a>
            </div>
            <span className="text-sm font-mono text-text-secondary w-full text-center md:w-auto md:text-right">Powered by Solana</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="font-mono text-lg text-white tabular-nums">{value}</div>
      <div className="text-xs font-sans text-text-tertiary uppercase tracking-wider">{label}</div>
    </div>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between py-1">
      <span className="text-sm font-sans text-text-secondary">{label}</span>
      <span className="text-sm font-mono text-white">{value}</span>
    </div>
  );
}

function Step({ n, title, desc }: { n: string; title: string; desc: string }) {
  return (
    <div className="space-y-2">
      <div className="font-mono text-sm text-text-tertiary">{n}</div>
      <h3 className="font-sans font-semibold text-base text-white">{title}</h3>
      <p className="text-sm text-text-secondary font-sans leading-relaxed">{desc}</p>
    </div>
  );
}
