"use client";

import React, { useState } from "react";
import { Market } from "@/types";

interface DepositWithdrawProps {
  market: Market;
}

export function DepositWithdraw({ market }: DepositWithdrawProps) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");

  // Mock balances
  const walletBalance = 50.24;
  const vaultBalance = 20.0;

  return (
    <div className="border-t border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-sans font-medium text-text-secondary uppercase tracking-wider">Balance</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary font-sans">Wallet</span>
        <span className="font-mono text-white">
          {walletBalance.toFixed(2)} {market.symbol}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary font-sans">Vault</span>
        <span className="font-mono text-white">
          {vaultBalance.toFixed(2)} {market.symbol}
        </span>
      </div>
      <div className="flex gap-2 pt-1">
        <div className="flex-1">
          <div className="flex items-center border border-zinc-700 rounded-[4px] focus-within:border-zinc-400 transition-colors duration-100">
            <input
              type="number"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              placeholder="0.00"
              className="w-full bg-transparent px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary"
            />
          </div>
        </div>
        <button
          onClick={() => setMode("deposit")}
          className={`px-4 py-2 text-sm font-sans rounded-[4px] border transition-colors duration-100 ${
            mode === "deposit"
              ? "border-zinc-400 text-white bg-white/[0.05]"
              : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
          }`}
        >
          Deposit
        </button>
        <button
          onClick={() => setMode("withdraw")}
          className={`px-4 py-2 text-sm font-sans rounded-[4px] border transition-colors duration-100 ${
            mode === "withdraw"
              ? "border-zinc-400 text-white bg-white/[0.05]"
              : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
          }`}
        >
          Withdraw
        </button>
      </div>
    </div>
  );
}
