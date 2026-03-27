import { Connection, PublicKey } from "@solana/web3.js";

// Metaplex Token Metadata Program
const TOKEN_METADATA_PROGRAM_ID = new PublicKey(
  "metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s"
);

// Solflare token list CDN (fallback for tokens not in known map)
// Note: Jupiter API requires auth as of 2026. We use known map + Metaplex instead.

// Well-known token logos (instant, no network needed)
const KNOWN_LOGOS: Record<string, string> = {
  // SOL
  "So11111111111111111111111111111111111111112":
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/So11111111111111111111111111111111111111112/logo.png",
  // BONK
  "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263":
    "https://arweave.net/hQiPZOsRZXGXBJd_82PhVdlM_hACsT_q6wqwf5cSY7I",
  // WIF
  "EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm":
    "https://assets.coingecko.com/coins/images/33566/small/dogwifhat.jpg",
  // JUP
  "JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN":
    "https://static.jup.ag/jup/icon.png",
  // JTO
  "jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL":
    "https://metadata.jito.network/token/jto/image",
  // RAY
  "4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R":
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R/logo.png",
  // ORCA
  "orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE":
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/orcaEKTdK7LKz57vaAYr9QeNsVEPfiu6QeMU1kektZE/logo.png",
  // USDC
  "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v":
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v/logo.png",
  // USDT
  "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB":
    "https://raw.githubusercontent.com/solana-labs/token-list/main/assets/mainnet/Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB/logo.svg",
  // PYTH
  "HZ1JovNiVvGrGNiiYvEozEVgZ58xaU3RKwX8eACQBCt3":
    "https://pyth.network/token.svg",
  // W (Wormhole)
  "85VBFQZC9TZkfaptBWjvUw7YbZjy52A6mjtPGjstQAmQ":
    "https://wormhole.com/token.png",
};

// In-memory cache: mint -> { logoUrl, timestamp }
interface CacheEntry {
  logoUrl: string | null;
  timestamp: number;
}

const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const NEGATIVE_CACHE_TTL_MS = 2 * 60 * 1000; // 2 minutes for misses

// Track in-flight requests to deduplicate
const inflight = new Map<string, Promise<string | null>>();

/**
 * Fetch a single token's logo from CoinGecko's Solana token endpoint.
 * Free, no auth, returns logo for any Solana token they track.
 */
async function fetchCoinGeckoLogo(mint: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://api.coingecko.com/api/v3/coins/solana/contract/${mint}`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.image?.small || data.image?.thumb || null;
  } catch {
    return null;
  }
}

/**
 * Derive the Metaplex metadata PDA for a given mint.
 */
function getMetadataPDA(mint: PublicKey): PublicKey {
  const [pda] = PublicKey.findProgramAddressSync(
    [
      Buffer.from("metadata"),
      TOKEN_METADATA_PROGRAM_ID.toBuffer(),
      mint.toBuffer(),
    ],
    TOKEN_METADATA_PROGRAM_ID
  );
  return pda;
}

/**
 * Decode the URI from a raw Metaplex metadata account.
 * Layout (v1):
 *   0: key (1 byte)
 *   1: update_authority (32 bytes)
 *   33: mint (32 bytes)
 *   65: name (4 bytes length + string)
 *   65+4+name_len: symbol (4 bytes length + string)
 *   ...: uri (4 bytes length + string)
 */
function decodeMetadataUri(data: Buffer): string | null {
  try {
    let offset = 1 + 32 + 32; // key + update_authority + mint

    // name: 4-byte LE length prefix + string
    if (offset + 4 > data.length) return null;
    const nameLen = data.readUInt32LE(offset);
    offset += 4 + nameLen;

    // symbol: 4-byte LE length prefix + string
    if (offset + 4 > data.length) return null;
    const symbolLen = data.readUInt32LE(offset);
    offset += 4 + symbolLen;

    // uri: 4-byte LE length prefix + string
    if (offset + 4 > data.length) return null;
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    if (offset + uriLen > data.length) return null;

    const uri = data
      .subarray(offset, offset + uriLen)
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();
    return uri || null;
  } catch {
    return null;
  }
}

/** Convert ipfs:// URIs to an HTTPS gateway URL. */
function ipfsToHttps(url: string): string {
  if (url.startsWith("ipfs://")) {
    return `https://ipfs.io/ipfs/${url.slice(7)}`;
  }
  return url;
}

/**
 * Fetch token metadata JSON from a URI and extract the image.
 */
async function fetchImageFromUri(uri: string): Promise<string | null> {
  try {
    const url = ipfsToHttps(uri);

    const resp = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!resp.ok) return null;

    const json = await resp.json();
    const imageUrl = json.image || json.logo || null;
    // The image URL itself might be ipfs:// — convert it too
    return imageUrl ? ipfsToHttps(imageUrl) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch logo from Jupiter Token API (covers pump.fun + most Solana tokens).
 */
async function fetchJupiterLogo(mint: string): Promise<string | null> {
  try {
    const resp = await fetch(
      `https://lite-api.jup.ag/tokens/v1/${mint}`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    return data.logoURI || null;
  } catch {
    return null;
  }
}

/**
 * Resolve token logo from on-chain Metaplex metadata (mainnet).
 * Uses a mainnet RPC since token metadata lives there.
 */
async function resolveMetaplex(
  mint: string,
  connection: Connection
): Promise<string | null> {
  try {
    const mintPubkey = new PublicKey(mint);
    const metadataPDA = getMetadataPDA(mintPubkey);
    const accountInfo = await connection.getAccountInfo(metadataPDA);

    if (!accountInfo || !accountInfo.data) return null;

    const uri = decodeMetadataUri(Buffer.from(accountInfo.data));
    if (!uri) return null;

    // If URI is already a direct image link
    if (/\.(png|jpg|jpeg|gif|svg|webp)(\?.*)?$/i.test(uri)) {
      return uri;
    }

    // Otherwise fetch the JSON and extract image
    return await fetchImageFromUri(uri);
  } catch (err) {
    console.warn(`[token-metadata] Metaplex lookup failed for ${mint}:`, err);
    return null;
  }
}

/**
 * Internal resolve (no dedup, called by getTokenLogo).
 */
async function resolveTokenLogo(
  mint: string,
  connection?: Connection
): Promise<string | null> {
  // 1. Known logos (instant)
  const known = KNOWN_LOGOS[mint];
  if (known) return known;

  // 2. Jupiter Token API (covers pump.fun + most Solana tokens, fast)
  const jupLogo = await fetchJupiterLogo(mint);
  if (jupLogo) return jupLogo;

  // 3. CoinGecko lookup (free, no auth)
  const cgLogo = await fetchCoinGeckoLogo(mint);
  if (cgLogo) return cgLogo;

  // 4. Metaplex on-chain fallback
  if (connection) {
    const metaplexLogo = await resolveMetaplex(mint, connection);
    if (metaplexLogo) return metaplexLogo;
  }

  return null;
}

/**
 * Get token logo URL for a mint address.
 * Strategy: known map -> cache -> Jupiter individual -> Metaplex on-chain -> null
 * Deduplicates concurrent requests for the same mint.
 */
export async function getTokenLogo(
  mint: string,
  connection?: Connection
): Promise<string | null> {
  const now = Date.now();

  // Check known logos first (no async needed)
  const known = KNOWN_LOGOS[mint];
  if (known) return known;

  // Check cache
  const cached = cache.get(mint);
  if (cached) {
    const ttl = cached.logoUrl ? CACHE_TTL_MS : NEGATIVE_CACHE_TTL_MS;
    if (now - cached.timestamp < ttl) {
      return cached.logoUrl;
    }
  }

  // Deduplicate in-flight requests
  const existing = inflight.get(mint);
  if (existing) return existing;

  const promise = resolveTokenLogo(mint, connection).then((result) => {
    cache.set(mint, { logoUrl: result, timestamp: Date.now() });
    inflight.delete(mint);
    return result;
  });

  inflight.set(mint, promise);
  return promise;
}

/**
 * Batch resolve logos for multiple mints.
 */
export async function getTokenLogos(
  mints: string[],
  connection?: Connection
): Promise<Map<string, string | null>> {
  const unique = Array.from(new Set(mints));
  const results = new Map<string, string | null>();

  const promises = unique.map(async (mint) => {
    const logo = await getTokenLogo(mint, connection);
    results.set(mint, logo);
  });

  await Promise.all(promises);
  return results;
}

/**
 * Clear the cache.
 */
export function clearTokenMetadataCache(): void {
  cache.clear();
}

/**
 * Full token metadata (name + symbol + logo) — for CreateMarket etc.
 */
export interface TokenMeta {
  name: string;
  symbol: string;
  logoUrl: string | null;
}

/**
 * Resolve full token metadata from Jupiter → Metaplex fallback.
 * Returns name, symbol, and logo in one shot.
 */
export async function getTokenMeta(
  mint: string,
  connection?: Connection
): Promise<TokenMeta> {
  // 1. Jupiter Token API (one call for everything)
  try {
    const resp = await fetch(
      `https://lite-api.jup.ag/tokens/v1/${mint}`,
      {
        signal: AbortSignal.timeout(5000),
        headers: { Accept: "application/json" },
      }
    );
    if (resp.ok) {
      const data = await resp.json();
      if (data.symbol || data.name) {
        return {
          name: data.name || "Unknown Token",
          symbol: data.symbol || mint.slice(0, 4),
          logoUrl: data.logoURI || null,
        };
      }
    }
  } catch {
    // fall through
  }

  // 2. Metaplex on-chain fallback (name + symbol from metadata, image from URI)
  if (connection) {
    try {
      const mintPubkey = new PublicKey(mint);
      const metadataPDA = getMetadataPDA(mintPubkey);
      const accountInfo = await connection.getAccountInfo(metadataPDA);

      if (accountInfo?.data) {
        const buf = Buffer.from(accountInfo.data);
        const parsed = decodeMetadataFull(buf);
        if (parsed) {
          let logoUrl: string | null = null;
          if (parsed.uri) {
            if (/\.(png|jpg|jpeg|gif|svg|webp)(\?.*)?$/i.test(parsed.uri)) {
              logoUrl = ipfsToHttps(parsed.uri);
            } else {
              logoUrl = await fetchImageFromUri(parsed.uri);
            }
          }
          return {
            name: parsed.name || "Unknown Token",
            symbol: parsed.symbol || mint.slice(0, 4),
            logoUrl,
          };
        }
      }
    } catch {
      // fall through
    }
  }

  return {
    name: "Unknown Token",
    symbol: mint.slice(0, 4),
    logoUrl: null,
  };
}

/**
 * Decode name, symbol, and URI from raw Metaplex metadata account.
 */
function decodeMetadataFull(
  data: Buffer
): { name: string; symbol: string; uri: string | null } | null {
  try {
    let offset = 1 + 32 + 32; // key + update_authority + mint

    if (offset + 4 > data.length) return null;
    const nameLen = data.readUInt32LE(offset);
    offset += 4;
    const name = data
      .subarray(offset, offset + nameLen)
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();
    offset += nameLen;

    if (offset + 4 > data.length) return null;
    const symbolLen = data.readUInt32LE(offset);
    offset += 4;
    const symbol = data
      .subarray(offset, offset + symbolLen)
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();
    offset += symbolLen;

    if (offset + 4 > data.length) return { name, symbol, uri: null };
    const uriLen = data.readUInt32LE(offset);
    offset += 4;
    if (offset + uriLen > data.length) return { name, symbol, uri: null };
    const uri = data
      .subarray(offset, offset + uriLen)
      .toString("utf8")
      .replace(/\0+$/, "")
      .trim();

    return { name, symbol, uri: uri || null };
  } catch {
    return null;
  }
}
