"use client";

import React, { memo, useMemo } from "react";
import { useTokenLogo } from "@/hooks/useTokenLogo";

function hashBytes(str: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < Math.min(str.length, 12); i++) {
    bytes.push(str.charCodeAt(i));
  }
  return bytes;
}

function identiconColor(mint: string): string {
  const b = hashBytes(mint);
  const h = ((b[0] || 0) * 7 + (b[1] || 0) * 13) % 360;
  return `hsl(${h}, 60%, 50%)`;
}

function identiconPattern(mint: string): boolean[][] {
  const b = hashBytes(mint);
  const grid: boolean[][] = [];
  for (let row = 0; row < 4; row++) {
    const r: boolean[] = [];
    for (let col = 0; col < 2; col++) {
      r.push(((b[(row * 2 + col) % b.length] || 0) & 1) === 1);
    }
    // Mirror
    r.push(r[1]);
    r.push(r[0]);
    grid.push(r);
  }
  return grid;
}

interface TokenLogoProps {
  mint: string;
  logoUrl?: string;
  size?: number;
}

export const TokenLogo = memo(function TokenLogo({
  mint,
  logoUrl: overrideUrl,
  size = 24,
}: TokenLogoProps) {
  // Resolve logo: override > Jupiter > Metaplex on-chain > identicon
  const resolvedUrl = useTokenLogo(mint, overrideUrl);
  const [imgError, setImgError] = React.useState(false);

  // Reset error state when URL changes
  React.useEffect(() => { setImgError(false); }, [resolvedUrl]);

  const identicon = useMemo(() => ({
    color: identiconColor(mint),
    pattern: identiconPattern(mint),
  }), [mint]);

  // Show resolved logo (if not errored)
  if (resolvedUrl && !imgError) {
    return (
      <img
        src={resolvedUrl}
        alt=""
        width={size}
        height={size}
        className="rounded-full"
        style={{ width: size, height: size }}
        onError={() => setImgError(true)}
      />
    );
  }

  // Loading state: show a subtle pulse (but only briefly — 2s max then identicon)
  if (resolvedUrl === null && !imgError) {
    return (
      <div
        className="rounded-full bg-zinc-800 animate-pulse"
        style={{ width: size, height: size }}
      />
    );
  }

  // Fallback: identicon
  const cellSize = size / 4;
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      className="rounded-full"
      style={{ background: "#18181b" }}
    >
      {identicon?.pattern.map((row, ri) =>
        row.map((filled, ci) =>
          filled ? (
            <rect
              key={`${ri}-${ci}`}
              x={ci * cellSize}
              y={ri * cellSize}
              width={cellSize}
              height={cellSize}
              fill={identicon.color}
            />
          ) : null
        )
      )}
    </svg>
  );
});
