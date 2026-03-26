'use client';

import { useState, useEffect } from 'react';
import { usePathname } from 'next/navigation';
import { TopBar } from './TopBar';
import { Sidebar } from './Sidebar';

export function Shell({ children }: { children: React.ReactNode }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const pathname = usePathname();

  // Close mobile menu on navigation
  useEffect(() => {
    setMenuOpen(false);
  }, [pathname]);

  return (
    <div className="min-h-screen bg-bg text-zinc-300 font-sans max-w-5xl mx-auto">
      <TopBar onMenuToggle={() => setMenuOpen(!menuOpen)} menuOpen={menuOpen} />

      <div className="flex">
        {/* Desktop sidebar */}
        <aside className="hidden lg:block w-56 shrink-0 border-r border-zinc-800 sticky top-12 h-[calc(100vh-3rem)] overflow-y-auto">
          <Sidebar />
        </aside>

        {/* Mobile sidebar overlay */}
        {menuOpen && (
          <>
            <div
              className="fixed inset-0 z-40 bg-black/60 lg:hidden"
              onClick={() => setMenuOpen(false)}
            />
            <aside className="fixed left-0 top-12 z-50 w-64 h-[calc(100vh-3rem)] bg-bg border-r border-zinc-800 overflow-y-auto lg:hidden">
              <Sidebar onNavigate={() => setMenuOpen(false)} />
            </aside>
          </>
        )}

        {/* Content */}
        <main className="flex-1 min-w-0">
          <div className="max-w-3xl mx-auto px-6 py-8 lg:px-10">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
}
