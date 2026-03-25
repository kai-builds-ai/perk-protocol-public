/**
 * Simple sliding-window rate limiter for transaction submission.
 * Tracks timestamps of sent TXs and enforces a max-per-minute cap.
 */
export class TxRateLimiter {
  private timestamps: number[] = [];

  constructor(private maxPerMinute: number) {}

  canSend(): boolean {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    return this.timestamps.length < this.maxPerMinute;
  }

  record(): void {
    this.timestamps.push(Date.now());
  }

  get remaining(): number {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => now - t < 60_000);
    return Math.max(0, this.maxPerMinute - this.timestamps.length);
  }
}
