import Link from 'next/link';
import type { NavItem } from '@/lib/navigation';

interface PrevNextProps {
  prev: NavItem | null;
  next: NavItem | null;
}

export function PrevNext({ prev, next }: PrevNextProps) {
  return (
    <div className="flex justify-between items-center mt-12 pt-6 border-t border-zinc-800">
      {prev ? (
        <Link
          href={`/${prev.slug}`}
          className="group flex flex-col text-left"
        >
          <span className="text-xs font-mono text-zinc-600 mb-1">← Previous</span>
          <span className="text-sm text-zinc-400 group-hover:text-white transition-colors">
            {prev.title}
          </span>
        </Link>
      ) : (
        <div />
      )}
      {next ? (
        <Link
          href={`/${next.slug}`}
          className="group flex flex-col text-right"
        >
          <span className="text-xs font-mono text-zinc-600 mb-1">Next →</span>
          <span className="text-sm text-zinc-400 group-hover:text-white transition-colors">
            {next.title}
          </span>
        </Link>
      ) : (
        <div />
      )}
    </div>
  );
}
