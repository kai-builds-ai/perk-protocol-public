'use client';

import Link from 'next/link';

interface TopBarProps {
  onMenuToggle: () => void;
  menuOpen: boolean;
}

export function TopBar({ onMenuToggle, menuOpen }: TopBarProps) {
  return (
    <header className="sticky top-0 z-50 h-12 border-b border-zinc-800 bg-bg/90 backdrop-blur-sm flex items-center justify-between px-4">
      <div className="flex items-center gap-3">
        <button
          onClick={onMenuToggle}
          className="lg:hidden text-zinc-400 hover:text-white p-1"
          aria-label="Toggle menu"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          >
            {menuOpen ? (
              <path d="M5 5l10 10M15 5L5 15" />
            ) : (
              <path d="M3 6h14M3 10h14M3 14h14" />
            )}
          </svg>
        </button>
        <Link href="/introduction" className="font-mono text-sm font-semibold text-white tracking-wider">
          PERK DOCS
        </Link>
      </div>
      <a
        href="https://perk.fund"
        target="_blank"
        rel="noopener noreferrer"
        className="text-xs font-mono text-zinc-500 hover:text-zinc-300 transition-colors"
      >
        perk.fund →
      </a>
    </header>
  );
}
