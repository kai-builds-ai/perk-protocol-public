export interface NavItem {
  slug: string;
  title: string;
  file: string;
}

export const navigation: NavItem[] = [
  { slug: 'introduction', title: 'Introduction', file: '01-introduction.md' },
  { slug: 'getting-started', title: 'Getting Started', file: '02-getting-started.md' },
  { slug: 'trading', title: 'Trading', file: '03-trading.md' },
  { slug: 'market-creation', title: 'Market Creation', file: '04-market-creation.md' },
  { slug: 'architecture', title: 'Architecture', file: '05-architecture.md' },
  { slug: 'perkoracle', title: 'PerkOracle', file: '06-perkoracle.md' },
  { slug: 'security', title: 'Security', file: '07-security.md' },
  { slug: 'sdk', title: 'SDK Reference', file: '08-sdk.md' },
  { slug: 'fees', title: 'Fees', file: '09-fees.md' },
  { slug: 'perk-token', title: '$PERK Token', file: '11-perk-token.md' },
  { slug: 'faq', title: 'FAQ', file: '10-faq.md' },
];

export function getNavIndex(slug: string): number {
  return navigation.findIndex((item) => item.slug === slug);
}

export function getPrevNext(slug: string): { prev: NavItem | null; next: NavItem | null } {
  const idx = getNavIndex(slug);
  return {
    prev: idx > 0 ? navigation[idx - 1] : null,
    next: idx < navigation.length - 1 ? navigation[idx + 1] : null,
  };
}
