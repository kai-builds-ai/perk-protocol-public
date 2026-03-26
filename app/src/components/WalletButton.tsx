"use client";

import React, { useState, useRef, useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { useRouter } from "next/navigation";
import { shortenAddress } from "@/lib/format";

export function WalletButton() {
  const { publicKey, disconnect, connected } = useWallet();
  const { setVisible } = useWalletModal();
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const router = useRouter();

  // Close dropdown on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) {
      document.addEventListener("mousedown", handleClick);
      return () => document.removeEventListener("mousedown", handleClick);
    }
  }, [open]);

  if (connected && publicKey) {
    const address = publicKey.toBase58();

    const handleCopy = () => {
      navigator.clipboard.writeText(address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    };

    return (
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setOpen((v) => !v)}
          className="font-mono text-xs border border-zinc-700 px-3 py-1.5 text-zinc-300 hover:text-white hover:border-zinc-500 rounded-[4px] transition-colors duration-100"
        >
          {shortenAddress(address)}
        </button>

        {open && (
          <div className="absolute top-full right-0 mt-1 w-52 bg-surface border border-border rounded-md shadow-lg z-50">
            {/* Address row */}
            <button
              onClick={handleCopy}
              className="w-full text-left px-4 py-2.5 text-xs font-mono text-zinc-400 hover:bg-white/5 transition-colors border-b border-border truncate"
              title={address}
            >
              {copied ? "Copied!" : `${address.slice(0, 16)}…${address.slice(-4)}`}
            </button>

            {/* My Markets */}
            <button
              onClick={() => {
                setOpen(false);
                router.push("/markets?filter=mine");
              }}
              className="w-full text-left px-4 py-2.5 text-sm font-sans text-zinc-300 hover:text-white hover:bg-white/5 transition-colors"
            >
              My Markets
            </button>

            {/* Disconnect */}
            <button
              onClick={() => {
                setOpen(false);
                disconnect();
              }}
              className="w-full text-left px-4 py-2.5 text-sm font-sans text-red-400 hover:text-red-300 hover:bg-white/5 transition-colors rounded-b-md"
            >
              Disconnect
            </button>
          </div>
        )}
      </div>
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
