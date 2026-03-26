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
    <nav className="border-b border-border relative">
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
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/markets" className="text-sm font-sans font-medium border border-white/80 text-white px-5 py-2 hover:bg-white/10 rounded-[4px] transition-colors duration-100 hidden sm:inline-block">
            Launch App
          </Link>
          <button onClick={() => setMenuOpen((v) => !v)} className="md:hidden flex flex-col justify-center items-center w-8 h-8 gap-1.5" aria-label="Toggle menu">
            <span className={`block w-5 h-px bg-white transition-transform duration-150 ${menuOpen ? "translate-y-[3.5px] rotate-45" : ""}`} />
            <span className={`block w-5 h-px bg-white transition-opacity duration-150 ${menuOpen ? "opacity-0" : ""}`} />
            <span className={`block w-5 h-px bg-white transition-transform duration-150 ${menuOpen ? "-translate-y-[3.5px] -rotate-45" : ""}`} />
          </button>
        </div>
      </div>
      {menuOpen && (
        <div className="absolute top-14 left-0 right-0 z-50 bg-bg border-b border-border md:hidden">
          <div className="flex flex-col px-4 py-3 gap-3 max-w-7xl mx-auto">
            <Link href="/markets" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Markets</Link>
            <Link href="/launch" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Create Market</Link>
            <a href="https://docs.perk.fund" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Docs</a>
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
        <div className="flex items-center px-4 md:px-8 py-8">
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
                        <Link href={`/trade/${m.symbol.toLowerCase()}`} className="flex items-center gap-2">
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
        <div className="border-t border-border px-4 md:px-8 py-8">
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
              <p className="text-sm text-text-secondary font-sans leading-relaxed max-w-xl">
                We&apos;re the only external team to find and fix a bug in the original Percolator — a warmup slope reset skip during liquidation.{" "}
                <a
                  href="https://github.com/aeyakovenko/percolator/issues/22"
                  className="text-white underline decoration-zinc-600 hover:decoration-white transition-colors"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Issue #22 →
                </a>
              </p>
            </div>
            <div className="w-px bg-border self-stretch hidden lg:block" />
            <div className="space-y-2.5 pt-1">
              <Detail label="Rust" value="5,820 lines" />
              <Detail label="Audits" value="7 rounds" />
              <Detail label="Verification" value="117 proofs" />
              <Detail label="Math" value="U256 / I256" />
              <Detail label="Oracle" value="Pyth + PerkOracle" />
              <Detail label="AMM" value="vAMM (x·y=k)" />
            </div>
          </div>
        </div>

        {/* How it works — three columns */}
        <div className="border-t border-border px-4 md:px-8 py-8">
          <div className="max-w-7xl mx-auto grid grid-cols-1 sm:grid-cols-3 gap-8 sm:gap-10">
            <Step n="01" title="Trade" desc="Long or short any token with up to 20x leverage. Pyth oracle prices. Sub-second execution on Solana." />
            <Step n="02" title="Create" desc="Launch a perpetual market for any SPL token. Set leverage, fees, oracle. One transaction. One SOL." />
            <Step n="03" title="Earn" desc="Market creators earn 10% of all trading fees on their market. Forever. No lockups, no vesting." />
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
              <a href="https://github.com/kai-builds-ai/perk-protocol" className="text-text-secondary hover:text-white transition-colors" aria-label="GitHub">
                <svg width="20" height="20" viewBox="0 0 24 24" fill="currentColor"><path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12"/></svg>
              </a>
              <a href="https://docs.perk.fund" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">Docs</a>
              <a href="https://discord.gg/perk" className="text-text-secondary hover:text-white transition-colors" aria-label="Discord">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><path d="M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189z"/></svg>
              </a>
            </div>
            <span className="text-sm font-mono text-text-secondary">Solana</span>
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
