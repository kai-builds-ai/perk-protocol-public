/**
 * Pyth Network price feeds — real-time SSE + historical candles.
 * No API key needed. Free public endpoints.
 */

// Pyth feed IDs (hex, without 0x prefix for API calls)
export const PYTH_FEEDS: Record<string, string> = {
  SOL: "ef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  BONK: "72b021217ca3fe68922a19aaf990109cb9d84e9ad004b4d2025ad6f529314419",
  WIF: "4ca4beeca86f0d164160323817a4e42b10010a724c2217c6ee41b54e6c18aafb",
  JUP: "0a0408d619e9380abad35060f9192039ed5042fa6f82301d0e48bb52be830996",
  JTO: "b43660a5f790c69354b0729a5ef9d50d68f1df92107540210b9cccba1f947cc2",
  RAY: "91568baa8beb53db23eb3fb7f22c6e8bd303d103919e19733f2bb642d3e7987a",
  ORCA: "37505261e557e251290b8c8899c4b4bafa0109b3cb69f7bdef63c6a71994b8f3",
};

// Pyth TradingView symbol names for historical API
export const PYTH_TV_SYMBOLS: Record<string, string> = {
  SOL: "Crypto.SOL/USD",
  BONK: "Crypto.BONK/USD",
  WIF: "Crypto.WIF/USD",
  JUP: "Crypto.JUP/USD",
  JTO: "Crypto.JTO/USD",
  RAY: "Crypto.RAY/USD",
  ORCA: "Crypto.ORCA/USD",
};

const HERMES_BASE = "https://hermes.pyth.network";
const BENCHMARKS_BASE = "https://benchmarks.pyth.network";

export interface PythPrice {
  price: number;
  conf: number;
  publishTime: number;
}

export interface CandleData {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

/**
 * Parse a raw Pyth price response into a number.
 */
function parsePythPrice(priceStr: string, expo: number): number {
  return parseInt(priceStr, 10) * Math.pow(10, expo);
}

/**
 * Fetch the latest price for a symbol from Hermes REST API.
 */
export async function fetchLatestPrice(symbol: string): Promise<PythPrice | null> {
  const feedId = PYTH_FEEDS[symbol];
  if (!feedId) return null;

  try {
    const resp = await fetch(
      `${HERMES_BASE}/api/latest_price_feeds?ids[]=0x${feedId}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return null;
    const data = await resp.json();
    if (!data[0]?.price) return null;

    const p = data[0].price;
    return {
      price: parsePythPrice(p.price, p.expo),
      conf: parsePythPrice(p.conf, p.expo),
      publishTime: p.publish_time,
    };
  } catch {
    return null;
  }
}

/**
 * Fetch latest prices for multiple symbols in one call.
 */
export async function fetchLatestPrices(
  symbols: string[]
): Promise<Map<string, PythPrice>> {
  const feedIds = symbols
    .map((s) => PYTH_FEEDS[s])
    .filter(Boolean);

  if (feedIds.length === 0) return new Map();

  try {
    const idsParam = feedIds.map((id) => `ids[]=0x${id}`).join("&");
    const resp = await fetch(
      `${HERMES_BASE}/api/latest_price_feeds?${idsParam}`,
      { signal: AbortSignal.timeout(5000) }
    );
    if (!resp.ok) return new Map();
    const data = await resp.json();

    const result = new Map<string, PythPrice>();
    for (const feed of data) {
      // Find symbol by feed ID
      const sym = Object.entries(PYTH_FEEDS).find(
        ([, id]) => id === feed.id
      )?.[0];
      if (sym && feed.price) {
        result.set(sym, {
          price: parsePythPrice(feed.price.price, feed.price.expo),
          conf: parsePythPrice(feed.price.conf, feed.price.expo),
          publishTime: feed.price.publish_time,
        });
      }
    }
    return result;
  } catch {
    return new Map();
  }
}

/**
 * Subscribe to real-time price updates via Hermes SSE (Server-Sent Events).
 * Returns an unsubscribe function.
 */
export function subscribePriceUpdates(
  symbols: string[],
  onUpdate: (symbol: string, price: PythPrice) => void
): () => void {
  const feedIds = symbols.map((s) => PYTH_FEEDS[s]).filter(Boolean);
  if (feedIds.length === 0) return () => {};

  const idsParam = feedIds.map((id) => `ids[]=0x${id}`).join("&");
  const url = `${HERMES_BASE}/v2/updates/price/stream?${idsParam}&parsed=true&allow_unordered=true&benchmarks_only=false`;

  let eventSource: EventSource | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;

  function connect() {
    if (closed) return;

    eventSource = new EventSource(url);

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (data.parsed) {
          for (const feed of data.parsed) {
            const sym = Object.entries(PYTH_FEEDS).find(
              ([, id]) => id === feed.id
            )?.[0];
            if (sym && feed.price) {
              onUpdate(sym, {
                price: parsePythPrice(feed.price.price, feed.price.expo),
                conf: parsePythPrice(feed.price.conf, feed.price.expo),
                publishTime: feed.price.publish_time,
              });
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    };

    eventSource.onerror = () => {
      eventSource?.close();
      // Reconnect after 3 seconds
      if (!closed) {
        reconnectTimer = setTimeout(connect, 3000);
      }
    };
  }

  connect();

  return () => {
    closed = true;
    eventSource?.close();
    if (reconnectTimer) clearTimeout(reconnectTimer);
  };
}

/**
 * Fetch historical candles from Pyth Benchmarks TradingView API.
 * resolution: "1" (1min), "5", "15", "60" (1hr), "D" (daily)
 */
export async function fetchHistoricalCandles(
  symbol: string,
  resolution: string = "60",
  count: number = 200
): Promise<CandleData[]> {
  const tvSymbol = PYTH_TV_SYMBOLS[symbol];
  if (!tvSymbol) return [];

  const now = Math.floor(Date.now() / 1000);
  // Calculate 'from' based on resolution and count
  let secondsPerBar: number;
  switch (resolution) {
    case "1": secondsPerBar = 60; break;
    case "5": secondsPerBar = 300; break;
    case "15": secondsPerBar = 900; break;
    case "60": secondsPerBar = 3600; break;
    case "D": secondsPerBar = 86400; break;
    default: secondsPerBar = 3600;
  }
  const from = now - count * secondsPerBar;

  try {
    const resp = await fetch(
      `${BENCHMARKS_BASE}/v1/shims/tradingview/history?symbol=${encodeURIComponent(tvSymbol)}&resolution=${resolution}&from=${from}&to=${now}`,
      { signal: AbortSignal.timeout(10000) }
    );
    if (!resp.ok) return [];
    const data = await resp.json();

    if (data.s !== "ok" || !data.t) return [];

    const candles: CandleData[] = [];
    for (let i = 0; i < data.t.length; i++) {
      candles.push({
        time: data.t[i],
        open: data.o[i],
        high: data.h[i],
        low: data.l[i],
        close: data.c[i],
      });
    }
    return candles;
  } catch {
    return [];
  }
}
