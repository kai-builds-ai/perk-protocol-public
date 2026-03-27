"use client";

import React, { useState, useEffect, useCallback, useRef } from "react";
import { Market } from "@/types";
import { usePerk } from "@/providers/PerkProvider";
import { useWallet } from "@solana/wallet-adapter-react";
import { useConnection } from "@solana/wallet-adapter-react";
import { PublicKey, SystemProgram, TransactionInstruction } from "@solana/web3.js";
import { BN } from "@coral-xyz/anchor";
import toast from "react-hot-toast";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createSyncNativeInstruction,
  NATIVE_MINT,
  createCloseAccountInstruction,
} from "@solana/spl-token";
import { getTokenDecimals, getTokenSymbol } from "@/lib/token-meta";
import { PerkClient } from "@perk/sdk";
import { sanitizeError } from "@/lib/error-utils";
import { simulateTransaction } from "@/lib/tx-simulation";

interface DepositWithdrawProps {
  market: Market;
}

const SOL_MINT = "So11111111111111111111111111111111111111112"

export function DepositWithdraw({ market }: DepositWithdrawProps) {
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [amount, setAmount] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const submitLockRef = useRef(false);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [vaultBalance, setVaultBalance] = useState<number | null>(null);

  const { client, readonlyClient } = usePerk();
  const { publicKey } = useWallet();
  const { connection } = useConnection();

  // C-02 fix: use collateralMint for everything — that's what gets deposited/withdrawn
  const collateralMint = market.collateralMint;
  const decimals = getTokenDecimals(collateralMint);
  const scale = Math.pow(10, decimals);
  const collateralSymbol = getTokenSymbol(collateralMint);
  const isSOLCollateral = collateralMint === SOL_MINT;

  // Fetch wallet balance of COLLATERAL token (not trading token)
  useEffect(() => {
    if (!publicKey || !connection) {
      setWalletBalance(null);
      return;
    }

    let cancelled = false;
    const fetchBalance = async () => {
      try {
        if (isSOLCollateral) {
          const bal = await connection.getBalance(publicKey);
          if (!cancelled) setWalletBalance(bal / scale);
        } else {
          const mint = new PublicKey(collateralMint);
          const ata = await getAssociatedTokenAddress(mint, publicKey);
          const bal = await connection.getTokenAccountBalance(ata);
          if (!cancelled) setWalletBalance(parseFloat(bal.value.uiAmountString ?? "0"));
        }
      } catch {
        if (!cancelled) setWalletBalance(0);
      }
    };

    fetchBalance();
    const interval = setInterval(fetchBalance, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [publicKey, connection, collateralMint, isSOLCollateral, scale]);

  // Fetch vault (deposited collateral) balance
  useEffect(() => {
    if (!publicKey || !readonlyClient) {
      setVaultBalance(null);
      return;
    }

    let cancelled = false;
    const fetchVault = async () => {
      try {
        const tokenMint = new PublicKey(market.tokenMint);
        const creator = new PublicKey(market.creator);
        const marketAddr = readonlyClient.getMarketAddress(tokenMint, creator);
        const pos = await readonlyClient.fetchPosition(marketAddr, publicKey);
        if (!cancelled) setVaultBalance(pos.depositedCollateral.toNumber() / scale);
      } catch {
        if (!cancelled) setVaultBalance(0);
      }
    };

    fetchVault();
    const interval = setInterval(fetchVault, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [publicKey, readonlyClient, market.tokenMint, scale]);

  const handleSubmit = useCallback(async () => {
    const amountNum = parseFloat(amount);
    if (submitLockRef.current) return;
    // H-02 fix: reject NaN, Infinity, zero, negative
    if (!Number.isFinite(amountNum) || amountNum <= 0) return;

    if (!client || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    // L-02 fix: client-side balance guards
    if (mode === "deposit" && walletBalance !== null && amountNum > walletBalance) {
      toast.error("Insufficient wallet balance.");
      return;
    }
    if (mode === "withdraw" && vaultBalance !== null && amountNum > vaultBalance) {
      toast.error("Insufficient vault balance.");
      return;
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    try {
      const tokenMint = new PublicKey(market.tokenMint);
      const oracle = new PublicKey(market.oracleAddress);
      const amountBN = new BN(Math.floor(amountNum * scale));

      // Ensure position account exists
      const creator = new PublicKey(market.creator);
      const marketAddr = client.getMarketAddress(tokenMint, creator);
      try {
        await client.fetchPosition(marketAddr, publicKey);
      } catch {
        await client.initializePosition(tokenMint, creator);
      }

      if (mode === "deposit") {
        if (isSOLCollateral) {
          // C-01 fix: atomic SOL wrapping — create a temp client with wrapping preInstructions
          const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
          const preIxs: TransactionInstruction[] = [];
          // Create WSOL ATA if it doesn't exist
          try {
            await connection.getTokenAccountBalance(wsolAta);
          } catch {
            preIxs.push(createAssociatedTokenAccountInstruction(publicKey, wsolAta, publicKey, NATIVE_MINT));
          }
          // Transfer native SOL → WSOL ATA + sync
          preIxs.push(
            SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: wsolAta, lamports: amountBN.toNumber() }),
            createSyncNativeInstruction(wsolAta),
          );
          // Create temporary client with wrapping pre-instructions for atomic TX
          const wrapClient = new PerkClient({
            connection,
            wallet: (client as any).provider.wallet,
            preInstructions: preIxs,
          });
          const sig = await wrapClient.deposit(tokenMint, creator, oracle, amountBN);
          toast.success("Deposited " + amountNum.toFixed(4) + " " + collateralSymbol + "\nTX: " + sig.slice(0, 16) + "...");
        } else {
          const sig = await client.deposit(tokenMint, creator, oracle, amountBN);
          toast.success("Deposited " + amountNum.toFixed(4) + " " + collateralSymbol + "\nTX: " + sig.slice(0, 16) + "...");
        }
      } else {
        // H-01 fix: for SOL withdrawals, use a client with postInstructions to atomically close WSOL ATA
        if (isSOLCollateral) {
          const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
          const closeIx = createCloseAccountInstruction(wsolAta, publicKey, publicKey);
          // Withdraw first, then close WSOL ATA to unwrap back to native SOL
          const sig = await client.withdraw(tokenMint, creator, oracle, amountBN);
          // Attempt atomic WSOL close — if it fails, user still has WSOL (Phantom auto-unwraps)
          try {
            const { Transaction } = await import("@solana/web3.js");
            const closeTx = new Transaction().add(closeIx);
            // Simulate before sending to avoid paying for a failed close
            closeTx.feePayer = publicKey;
            closeTx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
            const simResult = await simulateTransaction(connection, closeTx);
            if (!simResult.success) {
              throw new Error(simResult.error ?? "Simulation failed");
            }
            await (client as any).provider.sendAndConfirm(closeTx);
          } catch (closeErr) {
            console.warn("[DepositWithdraw] WSOL auto-unwrap failed — wallet will handle it");
            toast("Your SOL was withdrawn as Wrapped SOL. Your wallet should auto-unwrap it.", { icon: "ℹ️" });
          }
          toast.success("Withdrew " + amountNum.toFixed(4) + " " + collateralSymbol + "\nTX: " + sig.slice(0, 16) + "...");
        } else {
          const sig = await client.withdraw(tokenMint, creator, oracle, amountBN);
          toast.success("Withdrew " + amountNum.toFixed(4) + " " + collateralSymbol + "\nTX: " + sig.slice(0, 16) + "...");
        }
      }
      setAmount("");
    } catch (err: unknown) {
      toast.error(sanitizeError(err, mode));
    } finally {
      submitLockRef.current = false;
      setIsSubmitting(false);
    }
  }, [client, publicKey, amount, mode, market, scale, connection, isSOLCollateral, collateralSymbol, walletBalance, vaultBalance]);

  const displayWallet = walletBalance !== null ? walletBalance.toFixed(4) : "—";
  const displayVault = vaultBalance !== null ? vaultBalance.toFixed(4) : "—";

  return (
    <div className="border-b border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-sans font-medium text-text-secondary uppercase tracking-wider">Balance</span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary font-sans">Wallet</span>
        <span className="font-mono text-white">
          {displayWallet} {collateralSymbol}
        </span>
      </div>
      <div className="flex items-center justify-between text-sm">
        <span className="text-text-secondary font-sans">Vault</span>
        <span className="font-mono text-white">
          {displayVault} {collateralSymbol}
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
              disabled={isSubmitting}
              className="w-full bg-transparent px-3 py-2 text-sm font-mono text-white outline-none placeholder:text-text-tertiary disabled:opacity-50"
            />
          </div>
        </div>
        <button
          onClick={() => {
            if (mode === "deposit" && amount) {
              handleSubmit();
            } else {
              setMode("deposit");
            }
          }}
          disabled={isSubmitting}
          className={`px-4 py-2 text-sm font-sans rounded-[4px] border transition-colors duration-100 ${
            isSubmitting
              ? "border-zinc-800 text-zinc-600 cursor-not-allowed"
              : mode === "deposit"
              ? "border-zinc-400 text-white bg-white/[0.05]"
              : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
          }`}
        >
          {isSubmitting && mode === "deposit" ? "..." : "Deposit"}
        </button>
        <button
          onClick={() => {
            if (mode === "withdraw" && amount) {
              handleSubmit();
            } else {
              setMode("withdraw");
              // Pre-fill with vault balance (max withdrawable)
              if (vaultBalance && vaultBalance > 0) {
                setAmount(vaultBalance.toFixed(4));
              }
            }
          }}
          disabled={isSubmitting}
          className={`px-4 py-2 text-sm font-sans rounded-[4px] border transition-colors duration-100 ${
            isSubmitting
              ? "border-zinc-800 text-zinc-600 cursor-not-allowed"
              : mode === "withdraw"
              ? "border-zinc-400 text-white bg-white/[0.05]"
              : "border-zinc-700 text-text-secondary hover:text-white hover:border-zinc-500"
          }`}
        >
          {isSubmitting && mode === "withdraw" ? "..." : "Withdraw"}
        </button>
      </div>
    </div>
  );
}
