"use client";

import React from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { shortenAddress } from "@/lib/format";

export function WalletButton() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();

  if (connected && publicKey) {
    return (
      <button
        onClick={() => disconnect()}
        className="font-mono text-xs border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:text-white hover:border-zinc-500 rounded-[4px] transition-colors duration-100"
      >
        {shortenAddress(publicKey.toBase58())}
      </button>
    );
  }

  return (
    <button
      onClick={() => setVisible(true)}
      className="text-xs font-sans font-medium border border-white/80 text-white px-3 py-1.5 hover:bg-white/10 rounded-[4px] transition-colors duration-100"
    >
      Connect Wallet
    </button>
  );
}
