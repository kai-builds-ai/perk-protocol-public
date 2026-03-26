'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { navigation } from '@/lib/navigation';

export function Sidebar({ onNavigate }: { onNavigate?: () => void }) {
  const pathname = usePathname();
  const currentSlug = pathname.replace('/', '');

  return (
    <nav className="flex flex-col py-4">
      {navigation.map((item) => {
        const isActive = currentSlug === item.slug;
        return (
          <Link
            key={item.slug}
            href={`/${item.slug}`}
            onClick={onNavigate}
            className={`
              px-4 py-2 text-sm font-mono transition-colors border-l-2
              ${isActive
                ? 'border-white text-white bg-zinc-900/50'
                : 'border-transparent text-zinc-500 hover:text-zinc-300 hover:border-zinc-700'
              }
            `}
          >
            {item.title}
          </Link>
        );
      })}
    </nav>
  );
}
