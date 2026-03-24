"use client";

import { useState, useEffect, useRef } from "react";
import { Connection } from "@solana/web3.js";
import { getTokenLogo } from "@/lib/token-metadata";

// Metaplex metadata lives on mainnet — always use mainnet RPC for logo resolution
const RPC_URL = "https://api.mainnet-beta.solana.com";

// Shared connection instance (avoid creating per-hook)
let sharedConnection: Connection | null = null;
function getConnection(): Connection {
  if (!sharedConnection) {
    sharedConnection = new Connection(RPC_URL, "confirmed");
  }
  return sharedConnection;
}

/**
 * Hook to resolve a token logo URL from Jupiter + Metaplex fallback.
 * Returns null while loading, the URL when resolved, or undefined if not found.
 *
 * If `overrideUrl` is provided, skips resolution and returns it directly.
 */
export function useTokenLogo(
  mint: string,
  overrideUrl?: string
): string | null | undefined {
  const [logoUrl, setLogoUrl] = useState<string | null | undefined>(
    overrideUrl || null
  );
  const mintRef = useRef(mint);

  useEffect(() => {
    if (overrideUrl) {
      setLogoUrl(overrideUrl);
      return;
    }

    mintRef.current = mint;
    let cancelled = false;

    (async () => {
      try {
        const connection = getConnection();
        const url = await getTokenLogo(mint, connection);
        if (!cancelled && mintRef.current === mint) {
          setLogoUrl(url === null ? undefined : url);
        }
      } catch {
        if (!cancelled && mintRef.current === mint) {
          setLogoUrl(undefined);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [mint, overrideUrl]);

  return logoUrl;
}

/**
 * Hook to batch-resolve logos for multiple mints.
 * Returns a Map<mint, logoUrl | null>.
 */
export function useTokenLogos(
  mints: string[]
): Map<string, string | null> {
  const [logos, setLogos] = useState<Map<string, string | null>>(new Map());
  const mintsKey = mints.join(",");

  useEffect(() => {
    let cancelled = false;
    const connection = getConnection();

    (async () => {
      const results = new Map<string, string | null>();
      // Resolve in parallel, but cap concurrency at 6
      const queue = [...mints];
      const workers = Array.from({ length: Math.min(6, queue.length) }, async () => {
        while (queue.length > 0) {
          const mint = queue.shift()!;
          try {
            const url = await getTokenLogo(mint, connection);
            results.set(mint, url);
          } catch {
            results.set(mint, null);
          }
        }
      });
      await Promise.all(workers);
      if (!cancelled) setLogos(results);
    })();

    return () => { cancelled = true; };
  }, [mintsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  return logos;
}
