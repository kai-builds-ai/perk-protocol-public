"use client";

import React, { useMemo } from "react";
import {
  ConnectionProvider,
  WalletProvider,
} from "@solana/wallet-adapter-react";
import { WalletModalProvider } from "@solana/wallet-adapter-react-ui";
import {
  PhantomWalletAdapter,
  SolflareWalletAdapter,
} from "@solana/wallet-adapter-wallets";
import { SOLANA_RPC } from "@/lib/constants";
import { PerkProvider } from "@/providers/PerkProvider";
import { MarketsProvider } from "@/providers/MarketsProvider";
import { Toaster } from "react-hot-toast";
import "@solana/wallet-adapter-react-ui/styles.css";
import "./globals.css";

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const wallets = useMemo(
    () => [
      new PhantomWalletAdapter(),
      new SolflareWalletAdapter(),
    ],
    []
  );

  return (
    <html lang="en">
      <head>
        <title>Perk — Permissionless Perpetuals on Solana</title>
        <meta name="description" content="Trade any token with leverage. Permissionless perpetual futures on Solana." />
        <link rel="icon" href="/favicon.png" type="image/png" />
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600&family=Space+Grotesk:wght@400;500;600&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="bg-bg text-text-primary min-h-screen">
        <ConnectionProvider endpoint={SOLANA_RPC}>
          <WalletProvider wallets={wallets} autoConnect>
            <WalletModalProvider>
              <PerkProvider>
                <MarketsProvider>
                  <Toaster
                    position="bottom-right"
                    containerStyle={{ zIndex: 9999 }}
                    toastOptions={{
                      style: {
                        background: '#0f0f11',
                        color: '#fafafa',
                        border: '1px solid #1a1a1e',
                        fontFamily: 'JetBrains Mono, monospace',
                        fontSize: '13px',
                      },
                    }}
                  />
                  {children}
                </MarketsProvider>
              </PerkProvider>
            </WalletModalProvider>
          </WalletProvider>
        </ConnectionProvider>
      </body>
    </html>
  );
}
