"use client";

import React, { useState, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, Transaction } from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createCloseAccountInstruction,
  getAccount,
  TokenAccountNotFoundError,
  TokenInvalidAccountOwnerError,
} from "@solana/spl-token";
import { usePerk } from "@/providers/PerkProvider";
import { Market } from "@/types";
import { TokenLogo } from "./TokenLogo";
import { formatUsd } from "@/lib/format";
import toast from "react-hot-toast";

const SOL_MINT = "So11111111111111111111111111111111111111112";

interface MyMarketsPanelProps {
  markets: Market[];
}

export function MyMarketsPanel({ markets }: MyMarketsPanelProps) {
  const router = useRouter();
  const { client } = usePerk();
  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();
  const [claimingMarket, setClaimingMarket] = useState<string | null>(null);
  const [claimedMarkets, setClaimedMarkets] = useState<Set<string>>(new Set());
  const claimLockRef = useRef(false);

  // Reset optimistic state on wallet change
  React.useEffect(() => {
    setClaimedMarkets(new Set());
  }, [publicKey]);

  // P-06: Clear optimistic override when new fees accrue from polling
  React.useEffect(() => {
    setClaimedMarkets((prev) => {
      if (prev.size === 0) return prev;
      const next = new Set(prev);
      let changed = false;
      for (const addr of prev) {
        const m = markets.find((mk) => mk.address === addr);
        if (m && m.creatorClaimableFees > 0) {
          next.delete(addr);
          changed = true;
        }
      }
      return changed ? next : prev;
    });
  }, [markets]);

  const handleClaim = useCallback(
    async (market: Market) => {
      if (!client || !publicKey || claimLockRef.current) return;
      claimLockRef.current = true;
      setClaimingMarket(market.address);

      try {
        const tokenMint = new PublicKey(market.tokenMint);
        const isSOL = market.tokenMint === SOL_MINT;

        // CF-03: Use tokenMint for ATA (matches on-chain constraint)
        const recipientATA = await getAssociatedTokenAddress(
          tokenMint,
          publicKey
        );

        // CF-01: Create ATA if it doesn't exist (first-time claimers)
        try {
          await getAccount(connection, recipientATA);
        } catch (e) {
          if (!(e instanceof TokenAccountNotFoundError) && !(e instanceof TokenInvalidAccountOwnerError)) throw e;
          const createAtaTx = new Transaction().add(
            createAssociatedTokenAccountInstruction(
              publicKey,
              recipientATA,
              publicKey,
              tokenMint
            )
          );
          const ataSig = await sendTransaction(createAtaTx, connection);
          await connection.confirmTransaction(ataSig, "confirmed");
        }

        await client.claimFees(tokenMint, publicKey, recipientATA);

        if (isSOL) {
          // Close WSOL ATA to unwrap SOL back to native
          try {
            const closeTx = new Transaction().add(
              createCloseAccountInstruction(recipientATA, publicKey, publicKey)
            );
            const sig = await sendTransaction(closeTx, connection);
            await connection.confirmTransaction(sig, "confirmed");
          } catch {
            toast("Fees claimed, but SOL is in your WSOL account. Close it in your wallet to unwrap.", { icon: "⚠️" });
          }
        }

        const amount = market.creatorClaimableFees;
        setClaimedMarkets((prev) => new Set(prev).add(market.address));
        toast.success(
          `Fees claimed! ${amount.toFixed(4)} ${isSOL ? "SOL" : market.symbol}`
        );
      } catch (err: unknown) {
        const message =
          err instanceof Error ? err.message : "Failed to claim fees";
        console.error("[MyMarketsPanel] claim error:", err);
        toast.error(message);
      } finally {
        setClaimingMarket(null);
        claimLockRef.current = false;
      }
    },
    [client, publicKey, sendTransaction, connection]
  );

  if (markets.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-full gap-3">
        <span className="text-text-tertiary text-2xl">📊</span>
        <span className="text-sm font-sans text-text-secondary">
          You haven&apos;t created any markets yet.
        </span>
        <span className="text-xs font-sans text-text-tertiary">
          Create one to start earning fees.
        </span>
      </div>
    );
  }

  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="border-b border-border text-text-secondary font-sans">
          <th className="text-left py-2.5 px-4 font-medium">Token</th>
          <th className="text-right py-2.5 px-4 font-medium">Mark Price</th>
          <th className="text-right py-2.5 px-4 font-medium">
            Claimable Fees
          </th>
          <th className="text-right py-2.5 px-4 font-medium">
            Lifetime Earned
          </th>
          <th className="text-right py-2.5 px-4 font-medium w-28"></th>
        </tr>
      </thead>
      <tbody>
        {markets.map((m) => {
          const isClaiming = claimingMarket === m.address;
          const effectiveFees = claimedMarkets.has(m.address) ? 0 : m.creatorClaimableFees;
          const hasClaimable = effectiveFees > 0;

          return (
            <tr
              key={m.address}
              className="border-b border-border hover:bg-white/[0.02] transition-colors duration-75 cursor-pointer"
              onClick={() => router.push(`/trade/${m.address}`)}
            >
              {/* Token */}
              <td className="py-2.5 px-4">
                <div className="flex items-center gap-2.5">
                  <TokenLogo
                    mint={m.tokenMint}
                    symbol={m.symbol}
                    logoUrl={m.logoUrl}
                    size={24}
                  />
                  <div className="flex flex-col">
                    <span className="font-sans text-white text-sm leading-tight">
                      {m.symbol}
                    </span>
                    <span className="font-sans text-text-tertiary text-xs leading-tight">
                      {m.name}
                    </span>
                  </div>
                </div>
              </td>

              {/* Mark Price */}
              <td className="text-right py-2.5 px-4 font-mono text-white">
                {formatUsd(m.markPrice)}
              </td>

              {/* Claimable Fees */}
              <td
                className={`text-right py-2.5 px-4 font-mono ${
                  hasClaimable ? "text-green-400" : "text-zinc-500"
                }`}
              >
                {effectiveFees > 0
                  ? effectiveFees.toFixed(4)
                  : "0.0000"}
              </td>

              {/* Lifetime Earned */}
              <td className="text-right py-2.5 px-4 font-mono text-text-secondary">
                {m.creatorFeesEarned > 0
                  ? m.creatorFeesEarned.toFixed(4)
                  : "0.0000"}
              </td>

              {/* Claim Button */}
              <td className="text-right py-2.5 px-4">
                <button
                  disabled={!hasClaimable || isClaiming || !client}
                  onClick={(e) => {
                    e.stopPropagation();
                    handleClaim(m);
                  }}
                  className={`px-3 py-1 text-xs font-sans border rounded-[4px] transition-colors duration-75 ${
                    hasClaimable && !isClaiming
                      ? "border-green-400/50 text-green-400 hover:bg-green-400/10 hover:border-green-400"
                      : "border-zinc-700 text-zinc-500 opacity-50 cursor-not-allowed"
                  }`}
                >
                  {isClaiming ? "Claiming..." : "Claim"}
                </button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
