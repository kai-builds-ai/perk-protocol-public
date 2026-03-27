import { NextRequest, NextResponse } from "next/server";
import { Connection, PublicKey } from "@solana/web3.js";
import { Redis } from "@upstash/redis";

// ── Config ──

const PROGRAM_ID = new PublicKey("3L72e4b8wKJ8ReMpLUeXxVNrRGpiK6m4VYxeSnecpNW2");
const PROTOCOL_PDA = PublicKey.findProgramAddressSync(
  [Buffer.from("protocol")],
  PROGRAM_ID,
)[0];
const REQUIRED_LAMPORTS = 10_000_000; // 0.01 SOL
const REQUEST_TTL = 60 * 60 * 24 * 30; // 30 days
const RATE_LIMIT_TTL = 3600; // 1 hour

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL!,
  token: process.env.UPSTASH_REDIS_REST_TOKEN!,
});

const rpcUrl =
  process.env.HELIUS_RPC_URL ??
  process.env.NEXT_PUBLIC_RPC_URL ??
  "https://api.mainnet-beta.solana.com";

// ── Helpers ──

function isValidPubkey(s: string): boolean {
  try {
    new PublicKey(s);
    return true;
  } catch {
    return false;
  }
}

interface MarketRequest {
  mint: string;
  requester: string;
  symbol?: string;
  name?: string;
  txSignature: string;
  timestamp: number;
  status: "pending";
}

// ── POST: Submit a market request ──

export async function POST(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mint, txSignature, requester, symbol, name } = body as {
    mint?: string;
    txSignature?: string;
    requester?: string;
    symbol?: string;
    name?: string;
  };

  // Validate required fields
  if (!mint || !txSignature || !requester) {
    return NextResponse.json(
      { error: "Missing required fields: mint, txSignature, requester" },
      { status: 400 },
    );
  }

  if (!isValidPubkey(mint)) {
    return NextResponse.json({ error: "Invalid mint address" }, { status: 400 });
  }
  if (!isValidPubkey(requester)) {
    return NextResponse.json({ error: "Invalid requester address" }, { status: 400 });
  }

  // Rate limit: 1 request per wallet per hour
  const rateLimitKey = `ratelimit:request:${requester}`;
  const existing = await redis.get(rateLimitKey);
  if (existing) {
    return NextResponse.json(
      { error: "Rate limited. You can submit one request per hour." },
      { status: 429 },
    );
  }

  // Check if this mint already has a pending request
  const existingRequest = await redis.get<MarketRequest>(`market-request:${mint}`);
  if (existingRequest) {
    return NextResponse.json(
      { error: "A request for this token is already pending." },
      { status: 400 },
    );
  }

  // Prevent TX signature replay — each TX can only be used once
  // Exception: if the same TX + same mint, allow retry (client might have failed after paying)
  const txUsedForMint = await redis.get<string>(`tx-used:${txSignature}`);
  if (txUsedForMint && txUsedForMint !== mint) {
    return NextResponse.json(
      { error: "This transaction has already been used for a different request." },
      { status: 400 },
    );
  }

  // Verify the TX signature on-chain
  const connection = new Connection(rpcUrl, "confirmed");

  let tx;
  try {
    tx = await connection.getTransaction(txSignature, {
      maxSupportedTransactionVersion: 0,
      commitment: "confirmed",
    });
  } catch (err) {
    console.error("[request-market] RPC error fetching TX:", err);
    return NextResponse.json(
      { error: "Failed to verify transaction. Try again in a moment." },
      { status: 502 },
    );
  }

  if (!tx || !tx.meta) {
    return NextResponse.json(
      { error: "Transaction not found or not yet confirmed." },
      { status: 402 },
    );
  }

  if (tx.meta.err) {
    return NextResponse.json(
      { error: "Transaction failed on-chain." },
      { status: 402 },
    );
  }

  // Verify: sender matches requester, recipient is protocol PDA, amount >= 0.01 SOL
  const accountKeys = tx.transaction.message.getAccountKeys();
  const preBalances = tx.meta.preBalances;
  const postBalances = tx.meta.postBalances;

  // Find the protocol PDA in the account keys and verify transfer
  let protocolIndex = -1;
  let senderIndex = -1;

  for (let i = 0; i < accountKeys.length; i++) {
    const key = accountKeys.get(i);
    if (key && key.equals(PROTOCOL_PDA)) {
      protocolIndex = i;
    }
    if (key && key.toBase58() === requester) {
      senderIndex = i;
    }
  }

  if (senderIndex === -1) {
    return NextResponse.json(
      { error: "Transaction sender does not match requester." },
      { status: 402 },
    );
  }

  if (protocolIndex === -1) {
    return NextResponse.json(
      { error: "Transaction does not involve the protocol PDA." },
      { status: 402 },
    );
  }

  // Check that the protocol PDA received >= REQUIRED_LAMPORTS
  const protocolReceived = postBalances[protocolIndex] - preBalances[protocolIndex];
  if (protocolReceived < REQUIRED_LAMPORTS) {
    return NextResponse.json(
      { error: `Transaction must transfer at least ${REQUIRED_LAMPORTS / 1e9} SOL to the protocol.` },
      { status: 402 },
    );
  }

  // All checks passed — store the request
  const request: MarketRequest = {
    mint,
    requester,
    symbol: typeof symbol === "string" ? symbol.slice(0, 20) : undefined,
    name: typeof name === "string" ? name.slice(0, 50) : undefined,
    txSignature,
    timestamp: Date.now(),
    status: "pending",
  };

  await redis.set(`market-request:${mint}`, JSON.stringify(request), { ex: REQUEST_TTL });

  // Mark TX signature as used (prevent replay) — store mint for retry allowance
  await redis.set(`tx-used:${txSignature}`, mint, { ex: REQUEST_TTL });

  // Set rate limit
  await redis.set(rateLimitKey, "1", { ex: RATE_LIMIT_TTL });

  return NextResponse.json({ success: true, request });
}

// ── GET: List all pending requests ──

export async function GET() {
  try {
    // Scan for all market-request:* keys
    const requests: MarketRequest[] = [];
    let cursor = 0;
    let done = false;

    while (!done) {
      const result = await redis.scan(cursor, {
        match: "market-request:*",
        count: 100,
      });
      // Upstash returns [cursor, keys] — cursor is number
      const nextCursor = Number(result[0]);
      const keys = result[1] as string[];
      cursor = nextCursor;

      if (keys.length > 0) {
        const values = await redis.mget<(string | null)[]>(...keys);
        for (const val of values) {
          if (val) {
            try {
              const parsed: MarketRequest =
                typeof val === "string" ? JSON.parse(val) : (val as MarketRequest);
              if (parsed.status === "pending") {
                requests.push(parsed);
              }
            } catch {
              // Skip malformed entries
            }
          }
        }
      }

      if (nextCursor === 0) done = true;
    }

    // Sort by timestamp descending (newest first)
    requests.sort((a, b) => b.timestamp - a.timestamp);

    return NextResponse.json({ requests });
  } catch (err) {
    console.error("[request-market] GET error:", err);
    return NextResponse.json(
      { error: "Failed to fetch requests" },
      { status: 500 },
    );
  }
}

// ── DELETE: Remove a request ──

export async function DELETE(req: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { mint } = body as { mint?: string };

  if (!mint || !isValidPubkey(mint)) {
    return NextResponse.json({ error: "Invalid or missing mint address" }, { status: 400 });
  }

  await redis.del(`market-request:${mint}`);

  return NextResponse.json({ success: true });
}
