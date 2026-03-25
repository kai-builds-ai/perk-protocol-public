"use client";

import React, { createContext, useContext, useMemo } from "react";
import { useConnection } from "@solana/wallet-adapter-react";
import { useAnchorWallet } from "@solana/wallet-adapter-react";
import { AnchorProvider, Wallet } from "@coral-xyz/anchor";
import { Keypair } from "@solana/web3.js";
import { PerkClient } from "@perk/sdk";

interface PerkContextValue {
  /** Client with full wallet — null when no wallet connected */
  client: PerkClient | null;
  /** Read-only client (always available) — for fetching markets without a wallet */
  readonlyClient: PerkClient;
}

const PerkContext = createContext<PerkContextValue | null>(null);

/** Dummy wallet for read-only provider (never signs) */
function makeDummyWallet(): Wallet {
  const kp = Keypair.generate();
  return {
    publicKey: kp.publicKey,
    signTransaction: () => { throw new Error("Read-only client cannot sign"); },
    signAllTransactions: () => { throw new Error("Read-only client cannot sign"); },
    payer: kp,
  } as unknown as Wallet;
}

export function PerkProvider({ children }: { children: React.ReactNode }) {
  const { connection } = useConnection();
  const anchorWallet = useAnchorWallet();

  const readonlyClient = useMemo(() => {
    const dummyWallet = makeDummyWallet();
    return new PerkClient({
      connection,
      wallet: dummyWallet,
      commitment: "confirmed",
    });
  }, [connection]);

  const client = useMemo(() => {
    if (!anchorWallet) return null;
    return new PerkClient({
      connection,
      wallet: anchorWallet as unknown as Wallet,
      commitment: "confirmed",
    });
  }, [connection, anchorWallet]);

  return (
    <PerkContext.Provider value={{ client, readonlyClient }}>
      {children}
    </PerkContext.Provider>
  );
}

export function usePerk(): PerkContextValue {
  const ctx = useContext(PerkContext);
  if (!ctx) throw new Error("usePerk must be used within PerkProvider");
  return ctx;
}
