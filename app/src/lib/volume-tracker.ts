/**
 * Client-side 24h volume tracking via localStorage snapshots.
 *
 * On each market fetch, we record { timestamp, totalVolume } per market.
 * To compute 24h volume: current totalVolume - totalVolume ~24h ago.
 *
 * Limitations:
 * - Resets on localStorage clear / new device / incognito
 * - Takes 24h to "warm up" on first visit
 * - Falls back to lifetime totalVolume if no 24h snapshot exists
 */

const STORAGE_KEY = "perk_volume_snapshots";
const SNAPSHOT_INTERVAL_MS = 5 * 60 * 1000; // Record at most every 5 minutes
const WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_AGE_MS = 25 * 60 * 60 * 1000; // Prune after 25 hours

interface VolumeSnapshot {
  ts: number; // unix ms
  vol: number; // totalVolume at that time
}

type SnapshotStore = Record<string, VolumeSnapshot[]>;

function loadStore(): SnapshotStore {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveStore(store: SnapshotStore): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
  } catch {
    // localStorage full or unavailable — silently fail
  }
}

/**
 * Record a volume snapshot for a market. Throttled to one per SNAPSHOT_INTERVAL.
 */
export function recordVolumeSnapshot(marketAddress: string, totalVolume: number): void {
  if (typeof window === "undefined") return;

  const store = loadStore();
  const snapshots = store[marketAddress] ?? [];
  const now = Date.now();

  // Throttle: skip if last snapshot is recent
  const last = snapshots[snapshots.length - 1];
  if (last && now - last.ts < SNAPSHOT_INTERVAL_MS) return;

  // Add new snapshot
  snapshots.push({ ts: now, vol: totalVolume });

  // Prune old entries (> 25h)
  const cutoff = now - MAX_AGE_MS;
  store[marketAddress] = snapshots.filter((s) => s.ts > cutoff);

  saveStore(store);
}

/**
 * Compute 24h volume for a market.
 * Returns the diff between current totalVolume and the closest snapshot to 24h ago.
 * Falls back to totalVolume (lifetime) if no historical snapshot exists.
 */
export function getVolume24h(marketAddress: string, currentTotalVolume: number): number {
  if (typeof window === "undefined") return currentTotalVolume;

  const store = loadStore();
  const snapshots = store[marketAddress] ?? [];

  if (snapshots.length === 0) return currentTotalVolume;

  const now = Date.now();
  const targetTs = now - WINDOW_MS;

  // Find the snapshot closest to 24h ago
  let closest: VolumeSnapshot | null = null;
  let closestDiff = Infinity;

  for (const snap of snapshots) {
    const diff = Math.abs(snap.ts - targetTs);
    if (diff < closestDiff) {
      closestDiff = diff;
      closest = snap;
    }
  }

  if (!closest) return currentTotalVolume;

  // If closest snapshot is less than 20h old, we don't have a full 24h window yet
  // Use it anyway but the volume will be an underestimate (better than lifetime)
  const volume = Math.max(0, currentTotalVolume - closest.vol);

  // Sanity: if volume is 0 and we have totalVolume, the tracker just started
  // Return totalVolume as fallback only if we have no meaningful history (< 1h of snapshots)
  const oldestSnapshot = snapshots[0];
  if (volume === 0 && oldestSnapshot && now - oldestSnapshot.ts < 60 * 60 * 1000) {
    return currentTotalVolume;
  }

  return volume;
}
