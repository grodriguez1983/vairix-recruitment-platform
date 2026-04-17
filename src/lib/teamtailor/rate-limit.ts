/**
 * Token-bucket rate limiter.
 *
 * Usage (single caller):
 *   const bucket = new TokenBucket({ tokensPerSecond: 4, burst: 10 });
 *   const wait = bucket.pendingWaitMs();
 *   if (wait > 0) await sleep(wait);
 *   bucket.take();
 *
 * The bucket itself is synchronous and uses an injectable clock so
 * tests can advance time deterministically. Callers are responsible
 * for actually sleeping before `take()` — this keeps scheduling
 * strategy (setTimeout, abortable timers, etc.) out of the bucket.
 */
export interface TokenBucketOptions {
  /** Steady-state refill rate (tokens per second). Must be > 0. */
  tokensPerSecond: number;
  /** Max tokens in the bucket (also starting capacity). Must be > 0. */
  burst: number;
  /** Monotonic clock. Defaults to Date.now. */
  now?: () => number;
}

export class TokenBucket {
  private readonly tokensPerSecond: number;
  private readonly burst: number;
  private readonly now: () => number;
  private tokens: number;
  private lastRefill: number;

  constructor(opts: TokenBucketOptions) {
    if (!Number.isFinite(opts.tokensPerSecond) || opts.tokensPerSecond <= 0) {
      throw new Error(`tokensPerSecond must be > 0 (got ${opts.tokensPerSecond})`);
    }
    if (!Number.isFinite(opts.burst) || opts.burst <= 0) {
      throw new Error(`burst must be > 0 (got ${opts.burst})`);
    }
    this.tokensPerSecond = opts.tokensPerSecond;
    this.burst = opts.burst;
    this.now = opts.now ?? Date.now;
    this.tokens = opts.burst;
    this.lastRefill = this.now();
  }

  private refill(): void {
    const now = this.now();
    const elapsedMs = now - this.lastRefill;
    if (elapsedMs <= 0) return;
    const added = (elapsedMs / 1000) * this.tokensPerSecond;
    this.tokens = Math.min(this.burst, this.tokens + added);
    this.lastRefill = now;
  }

  /**
   * Returns 0 if at least one token is available, otherwise the
   * number of milliseconds to wait until the next token arrives.
   * Rounded up so callers never under-wait.
   */
  pendingWaitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const needed = 1 - this.tokens;
    return Math.ceil((needed / this.tokensPerSecond) * 1000);
  }

  /**
   * Consumes one token. Caller MUST have awaited `pendingWaitMs()`
   * first — `take()` throws if the bucket is empty rather than
   * silently going negative.
   */
  take(): void {
    this.refill();
    if (this.tokens < 1) {
      throw new Error('no tokens available; await pendingWaitMs() before take()');
    }
    this.tokens -= 1;
  }
}
