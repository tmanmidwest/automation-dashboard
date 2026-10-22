/**
 * Fixed-window, in-memory rate limiter keyed by caller (a client id, a token id, …). Per
 * process: with several app instances each enforces its own window, which is acceptable for
 * the low limits it guards (external catalog reads, machine token requests).
 */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
  ) {}

  /** Count one hit for `key`. Returns null when allowed, else seconds until the window resets. */
  hit(key: string, now = Date.now()): number | null {
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      this.prune(now);
      return null;
    }
    if (w.count >= this.limit) return Math.max(1, Math.ceil((w.start + this.windowMs - now) / 1000));
    w.count++;
    return null;
  }

  /** Drop expired windows so the map can't grow without bound. */
  private prune(now: number) {
    if (this.windows.size < 1000) return;
    for (const [k, w] of this.windows) if (now - w.start >= this.windowMs) this.windows.delete(k);
  }
}
