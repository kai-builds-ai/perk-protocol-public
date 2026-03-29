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
import { PerkClient, accountEquity, calculateMarkPrice, LEVERAGE_SCALE, POS_SCALE, PRICE_SCALE } from "@perk/sdk";
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
  const [vaultBalanceRaw, setVaultBalanceRaw] = useState<number>(0); // lamports
  const [freeCollateral, setFreeCollateral] = useState<number | null>(null);
  const [marginUsed, setMarginUsed] = useState<number | null>(null);
  const [hasOpenPosition, setHasOpenPosition] = useState(false);

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
        const rawLamports = pos.depositedCollateral.toNumber();
        const depositedHuman = rawLamports / scale;
        if (!cancelled) { setVaultBalance(depositedHuman); setVaultBalanceRaw(rawLamports); }

        // Free collateral = equity - initial margin requirement
        const marketAccount = await readonlyClient.fetchMarket(tokenMint, creator);
        const equity = accountEquity(pos);
        const equityHuman = equity.toNumber() / scale;
        const baseSize = pos.baseSize.toNumber() / POS_SCALE;
        if (!cancelled) setHasOpenPosition(pos.baseSize.toNumber() !== 0);
        const maxLev = marketAccount.maxLeverage / LEVERAGE_SCALE;
        const imBps = maxLev > 0 ? Math.floor(10000 / maxLev) : 10000;
        const mPrice = calculateMarkPrice(marketAccount);
        const notional = Math.abs(baseSize) * mPrice;
        const imRequired = notional * imBps / 10000;
        if (!cancelled) {
          setFreeCollateral(Math.max(0, equityHuman - imRequired));
          setMarginUsed(pos.baseSize.toNumber() !== 0 ? imRequired : 0);
        }
      } catch {
        if (!cancelled) { setVaultBalance(0); setFreeCollateral(0); setMarginUsed(0); }
      }
    };

    fetchVault();
    const interval = setInterval(fetchVault, 15_000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [publicKey, readonlyClient, market.tokenMint, scale]);

  const handleSubmit = useCallback(async () => {
    let amountNum = parseFloat(amount);
    if (submitLockRef.current) return;
    // H-02 fix: reject NaN, Infinity, zero, negative
    if (!Number.isFinite(amountNum) || amountNum <= 0) return;

    if (!client || !publicKey) {
      toast.error("Please connect your wallet first.");
      return;
    }

    // L-02 fix: client-side balance guards
    if (mode === "deposit" && walletBalance !== null && amountNum > walletBalance) {
      toast.error("Not enough in wallet. Top up first!");
      return;
    }
    if (mode === "withdraw" && vaultBalance !== null) {
      if (amountNum > vaultBalance) {
        // Rounding tolerance: if within 0.5%, clamp DOWN to exact vault balance
        if (amountNum <= vaultBalance * 1.005) {
          amountNum = vaultBalance;
        } else {
          toast.error("Insufficient vault balance.");
          return;
        }
      }
    }

    submitLockRef.current = true;
    setIsSubmitting(true);
    try {
      const tokenMint = new PublicKey(market.tokenMint);
      const oracle = new PublicKey(market.oracleAddress);
      const creator = new PublicKey(market.creator);
      const marketAddr = client.getMarketAddress(tokenMint, creator);

      // Ensure position account exists
      let pos;
      try {
        pos = await client.fetchPosition(marketAddr, publicKey);
      } catch {
        await client.initializePosition(tokenMint, creator);
        pos = await client.fetchPosition(marketAddr, publicKey);
      }

      // For withdrawals, re-read on-chain collateral to avoid stale/rounded values
      let amountBN: InstanceType<typeof BN>;
      if (mode === "withdraw") {
        const onChainCollateral = pos.depositedCollateral.toNumber();
        const requestedLamports = Math.floor(amountNum * scale);
        // If requesting within 1% of on-chain collateral, withdraw exact on-chain amount
        if (requestedLamports >= onChainCollateral * 0.99) {
          amountBN = new BN(onChainCollateral);
        } else {
          amountBN = new BN(requestedLamports);
        }
      } else {
        amountBN = new BN(Math.floor(amountNum * scale));
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
          toast.success("Margin added: " + amountNum.toFixed(4) + " " + collateralSymbol + "\nTX: " + sig.slice(0, 16) + "...");
        } else {
          const sig = await client.deposit(tokenMint, creator, oracle, amountBN);
          toast.success("Margin added: " + amountNum.toFixed(4) + " " + collateralSymbol + "\nTX: " + sig.slice(0, 16) + "...");
        }
      } else {
        // H-01 fix: for SOL withdrawals, create WSOL ATA if needed, withdraw, then close to unwrap
        if (isSOLCollateral) {
          const wsolAta = await getAssociatedTokenAddress(NATIVE_MINT, publicKey);
          // Ensure WSOL ATA exists before withdraw (may have been closed after a previous withdraw)
          const preIxs: TransactionInstruction[] = [];
          try {
            await connection.getTokenAccountBalance(wsolAta);
          } catch {
            preIxs.push(createAssociatedTokenAccountInstruction(publicKey, wsolAta, publicKey, NATIVE_MINT));
          }
          const closeIx = createCloseAccountInstruction(wsolAta, publicKey, publicKey);
          // Create client with pre-instructions to atomically create ATA + withdraw
          const withdrawClient = preIxs.length > 0
            ? new PerkClient({ connection, wallet: (client as any).provider.wallet, preInstructions: preIxs })
            : client;
          const sig = await withdrawClient.withdraw(tokenMint, creator, oracle, amountBN);
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
  const displayFree = freeCollateral !== null ? (Math.floor(freeCollateral * 10000) / 10000).toFixed(4) : "—";

  if (!publicKey) {
    return (
      <div className="border-b border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-sans font-medium text-text-secondary uppercase tracking-wider">Balance</span>
        </div>
        <p className="text-xs text-text-tertiary font-sans text-center py-4">
          Connect wallet to deposit, trade, and view balances
        </p>
      </div>
    );
  }

  return (
    <div className="border-b border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-sans font-medium text-text-secondary uppercase tracking-wider">Balance</span>
      </div>
      <BalanceRow label="Wallet" tooltip="Your wallet balance" value={`${displayWallet} ${collateralSymbol}`} />
      <BalanceRow label="Vault" tooltip="Total collateral deposited in this market" value={`${displayVault} ${collateralSymbol}`} />
      {marginUsed !== null && marginUsed > 0 && (
        <BalanceRow
          label="Margin"
          tooltip="Locked as margin for your open position (10% of position value at 10x max leverage)"
          value={`${(Math.floor(marginUsed * 10000) / 10000).toFixed(4)} ${collateralSymbol}`}
          color="text-yellow-400"
        />
      )}
      <BalanceRow
        label="Buffer"
        tooltip="Vault minus margin — your liquidation cushion"
        value={`${displayFree} ${collateralSymbol}`}
        color="text-profit"
      />
      {mode === "withdraw" && hasOpenPosition && (
        <div className="text-xs font-sans text-yellow-400 bg-yellow-400/5 border border-yellow-400/20 rounded-[4px] px-3 py-2">
          ⚠ You have an open position. Close it first to withdraw all collateral.
        </div>
      )}
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
          {isSubmitting && mode === "deposit" ? "..." : "Add Margin"}
        </button>
        <button
          onClick={() => {
            if (mode === "withdraw" && amount) {
              handleSubmit();
            } else {
              setMode("withdraw");
              // Pre-fill with free collateral (max withdrawable), floor to avoid exceeding vault
              const maxWithdraw = freeCollateral ?? vaultBalance;
              if (maxWithdraw && maxWithdraw > 0) {
                setAmount((Math.floor(maxWithdraw * 10000) / 10000).toFixed(4));
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

/** Balance row with tap-to-reveal tooltip */
function BalanceRow({ label, tooltip, value, color = "text-white" }: {
  label: string;
  tooltip: string;
  value: string;
  color?: string;
}) {
  const [showTip, setShowTip] = React.useState(false);
  return (
    <div className="text-sm">
      <div className="flex items-center justify-between">
        <span
          className="text-text-secondary font-sans flex items-center gap-1 cursor-help"
          onClick={() => setShowTip(!showTip)}
        >
          {label}
          <svg className="w-3 h-3 text-text-tertiary" viewBox="0 0 16 16" fill="currentColor">
            <path d="M8 0a8 8 0 100 16A8 8 0 008 0zm.93 12.28h-1.9v-1.6h1.9v1.6zm2.02-5.46c-.18.27-.56.59-1.13.96-.36.24-.58.45-.67.64-.08.17-.12.42-.12.76h-1.8c0-.57.08-1.01.24-1.33.16-.31.5-.65 1.02-.99.42-.28.7-.52.84-.72.14-.2.21-.43.21-.68 0-.32-.11-.58-.33-.77-.22-.2-.52-.29-.9-.29-.38 0-.68.1-.91.3s-.35.48-.35.83H5.3c.02-.88.33-1.55.93-2.02.6-.47 1.38-.7 2.33-.7.99 0 1.77.23 2.33.68.56.45.84 1.06.84 1.83 0 .5-.13.93-.38 1.3z" />
          </svg>
        </span>
        <span className={`font-mono ${color}`}>{value}</span>
      </div>
      {showTip && (
        <p className="text-[10px] font-sans text-text-tertiary mt-0.5 ml-0.5">
          {tooltip}
        </p>
      )}
    </div>
  );
}
