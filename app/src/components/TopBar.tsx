"use client";

import React, { useState } from "react";
import Link from "next/link";
import { WalletButton } from "./WalletButton";
import { formatUsdCompact } from "@/lib/format";

interface TopBarProps {
  totalVolume?: number;
  totalMarkets?: number;
  solPrice?: number;
}

export function TopBar({
  totalVolume = 7100000,
  totalMarkets = 7,
  solPrice,
}: TopBarProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  return (
    <div className="relative">
      <div className="flex items-center justify-between h-12 px-4 md:px-6 border-b border-border bg-surface">
        <div className="flex items-center gap-4 md:gap-8 min-w-0">
          <Link href="/" className="flex items-center gap-2 flex-shrink-0">
            <div className="w-8 h-8 rounded-[3px] overflow-hidden bg-bg flex-shrink-0"><img src="/logo.png" alt="Perk" width={32} height={32} className="mix-blend-lighten" /></div>
            <span className="font-sans font-semibold text-base text-white tracking-[0.2em]">PERK</span>
          </Link>
          {solPrice != null && (
            <span className="text-sm text-text-secondary font-sans hidden sm:inline">
              SOL{" "}
              <span className="text-white font-mono">
                ${solPrice.toFixed(2)}
              </span>
            </span>
          )}
          <span className="text-sm text-text-secondary font-sans hidden sm:inline">
            Vol{" "}
            <span className="text-white font-mono">
              {formatUsdCompact(totalVolume)}
            </span>
          </span>
          <span className="text-sm text-text-secondary font-sans hidden md:inline">
            Markets{" "}
            <span className="text-white font-mono">{totalMarkets}</span>
          </span>
        </div>
        <div className="flex items-center gap-3 md:gap-4">
          <Link
            href="/launch"
            className="text-sm font-sans font-medium border border-zinc-600 text-white px-3 md:px-4 py-1.5 rounded-[4px] hover:bg-white/10 hover:border-zinc-400 transition-colors duration-100 hidden md:inline-block"
          >
            + Create Market
          </Link>
          <WalletButton />
          {/* Hamburger — visible below md */}
          <button
            onClick={() => setMenuOpen((v) => !v)}
            className="md:hidden flex flex-col justify-center items-center w-8 h-8 gap-1.5 mr-1"
            aria-label="Toggle menu"
          >
            <span className={`block w-5 h-px bg-white transition-transform duration-150 ${menuOpen ? "translate-y-[3.5px] rotate-45" : ""}`} />
            <span className={`block w-5 h-px bg-white transition-opacity duration-150 ${menuOpen ? "opacity-0" : ""}`} />
            <span className={`block w-5 h-px bg-white transition-transform duration-150 ${menuOpen ? "-translate-y-[3.5px] -rotate-45" : ""}`} />
          </button>
        </div>
      </div>

      {/* Mobile dropdown menu */}
      {menuOpen && (
        <div className="absolute top-12 left-0 right-0 z-50 bg-surface border-b border-border md:hidden">
          <div className="flex flex-col px-4 py-4 gap-5">
            <Link href="/markets" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-text-secondary hover:text-white transition-colors">
              Markets
            </Link>
            <Link href="/launch" onClick={() => setMenuOpen(false)} className="text-sm font-sans text-text-secondary hover:text-white transition-colors">
              + Create Market
            </Link>
            <a href="https://docs.perk.fund" className="text-sm font-sans text-text-secondary hover:text-white transition-colors">
              Docs
            </a>
            {solPrice != null && (
              <span className="text-sm text-text-secondary font-sans sm:hidden">
                SOL <span className="text-white font-mono">${solPrice.toFixed(2)}</span>
              </span>
            )}
            <span className="text-sm text-text-secondary font-sans sm:hidden">
              Vol <span className="text-white font-mono">{formatUsdCompact(totalVolume)}</span>
            </span>
            <span className="text-sm text-text-secondary font-sans md:hidden">
              Markets <span className="text-white font-mono">{totalMarkets}</span>
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
