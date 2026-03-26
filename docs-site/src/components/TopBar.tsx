'use client';

import Link from 'next/link';

interface TopBarProps {
  onMenuToggle: () => void;
  menuOpen: boolean;
}

export function TopBar({ onMenuToggle, menuOpen }: TopBarProps) {
  return (
    <header className="sticky top-0 z-50 h-12 border-b border-zinc-800 bg-[#0a0a0a]/95 backdrop-blur-sm flex items-center justify-between px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuToggle}
          className="lg:hidden text-zinc-400 hover:text-white p-1"
          aria-label="Toggle menu"
        >
          <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
            {menuOpen ? (
              <><line x1="4" y1="4" x2="16" y2="16"/><line x1="16" y1="4" x2="4" y2="16"/></>
            ) : (
              <><line x1="3" y1="5" x2="17" y2="5"/><line x1="3" y1="10" x2="17" y2="10"/><line x1="3" y1="15" x2="17" y2="15"/></>
            )}
          </svg>
        </button>
        <Link href="/introduction" className="flex items-center gap-2">
          <div className="w-6 h-6 rounded-[2px] overflow-hidden bg-[#0a0a0a] flex-shrink-0">
            <img src="/logo.png" alt="Perk" width={24} height={24} className="mix-blend-lighten" />
          </div>
          <span className="font-mono text-sm font-semibold text-white tracking-wider">PERK DOCS</span>
        </Link>
      </div>
      <div className="flex items-center gap-4">
        <a href="https://perk.fund" className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors hidden sm:inline">
          App
        </a>
        <a href="https://github.com/kai-builds-ai/perk-protocol" className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors hidden sm:inline">
          GitHub
        </a>
        <a href="https://perk.fund" className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors">
          perk.fund →
        </a>
      </div>
    </header>
  );
}
