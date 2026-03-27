"use client";

import { useState, useEffect, useRef } from "react";
import { Connection } from "@solana/web3.js";
import { getTokenLogo } from "@/lib/token-metadata";

// Metaplex metadata lives on mainnet — use Helius RPC (public mainnet returns 403 from Vercel)
const RPC_URL = process.env.NEXT_PUBLIC_HELIUS_RPC_URL || "https://mainnet.helius-rpc.com/?api-key=60b57283-2b78-4d4b-80b5-bb83495b0c09";

// Shared connection instance (avoid creating per-hook)
let sharedConnection: Connection | null = null;
function getConnection(): Connection {
  if (!sharedConnection) {
    sharedConnection = new Connection(RPC_URL, "confirmed");
  }
  return sharedConnection;
}

/**
 * Allowed image URL origins. Only serve images from these trusted domains
 * to prevent IP harvesting via malicious Metaplex metadata URIs.
 */
const ALLOWED_IMAGE_ORIGINS = [
  "raw.githubusercontent.com",
  "arweave.net",
  "assets.coingecko.com",
  "static.jup.ag",
  "metadata.jito.network",
  "pyth.network",
  "wormhole.com",
  "ipfs.io",
  "api.coingecko.com",
  "coin-images.coingecko.com",
  "shdw-drive.genesysgo.net",
  "gateway.irys.xyz",
  "bafkrei", // IPFS CIDv1 subdomains
  "cf-ipfs.com",
  "nftstorage.link",
  "tokens.jup.ag",
  "img.jup.ag",
];

/**
 * Validate that a URL is from a trusted image origin.
 */
function isTrustedImageUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    return ALLOWED_IMAGE_ORIGINS.some(
      (origin) => parsed.hostname === origin || parsed.hostname.endsWith("." + origin)
    );
  } catch {
    return false;
  }
}

/**
 * Hook to resolve a token logo URL from Jupiter + Metaplex fallback.
 * Returns null while loading, the URL when resolved, or undefined if not found.
 *
 * If `overrideUrl` is provided (e.g. from Jupiter search), skips resolution
 * and returns it directly. CSP img-src is the security layer for image loads.
 */
export function useTokenLogo(
  mint: string,
  overrideUrl?: string
): string | null | undefined {
  // Trust override URLs (from Jupiter search / our own resolution code).
  // CSP img-src handles the actual security; JS allowlist only for self-resolved URLs.
  const safeOverride = overrideUrl && overrideUrl.startsWith("https://") ? overrideUrl : undefined;

  const [logoUrl, setLogoUrl] = useState<string | null | undefined>(
    safeOverride || null
  );
  const mintRef = useRef(mint);

  useEffect(() => {
    if (safeOverride) {
      setLogoUrl(safeOverride);
      return;
    }

    mintRef.current = mint;
    let cancelled = false;

    (async () => {
      try {
        const connection = getConnection();
        const url = await getTokenLogo(mint, connection);
        // Only use resolved URL if from a trusted origin
        if (!cancelled && mintRef.current === mint) {
          if (url && isTrustedImageUrl(url)) {
            setLogoUrl(url);
          } else {
            setLogoUrl(undefined); // Fall back to identicon
          }
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
  }, [mint, safeOverride]);

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
