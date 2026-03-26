import type { Metadata } from 'next';
import { Shell } from '@/components/Shell';
import './globals.css';

export const metadata: Metadata = {
  title: 'Perk Docs — Permissionless Perpetual Futures on Solana',
  description: 'Documentation for Perk Protocol — permissionless perpetual futures on Solana.',
  icons: {
    icon: '/logo.png',
  },
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="bg-bg antialiased">
        <Shell>{children}</Shell>
      </body>
    </html>
  );
}
