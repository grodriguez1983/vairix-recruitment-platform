/**
 * Unit tests for the token bucket rate limiter.
 *
 * Clock is injected — no real time passes during tests.
 */
import { describe, expect, it } from 'vitest';
import { TokenBucket } from './rate-limit';

function makeClock(start: number): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

describe('TokenBucket', () => {
  it('starts full with burst tokens available', () => {
    const clock = makeClock(0);
    const bucket = new TokenBucket({ tokensPerSecond: 4, burst: 10, now: clock.now });
    expect(bucket.pendingWaitMs()).toBe(0);
  });

  it('allows burst tokens back-to-back without waiting', () => {
    const clock = makeClock(0);
    const bucket = new TokenBucket({ tokensPerSecond: 4, burst: 3, now: clock.now });

    expect(bucket.pendingWaitMs()).toBe(0);
    bucket.take();
    expect(bucket.pendingWaitMs()).toBe(0);
    bucket.take();
    expect(bucket.pendingWaitMs()).toBe(0);
    bucket.take();

    expect(bucket.pendingWaitMs()).toBeGreaterThan(0);
  });

  it('computes wait time based on refill rate when bucket is empty', () => {
    const clock = makeClock(0);
    const bucket = new TokenBucket({ tokensPerSecond: 4, burst: 1, now: clock.now });
    bucket.take();
    // 4 tokens/s = 250ms per token
    expect(bucket.pendingWaitMs()).toBe(250);
  });

  it('refills tokens proportionally with elapsed time', () => {
    const clock = makeClock(0);
    const bucket = new TokenBucket({ tokensPerSecond: 10, burst: 5, now: clock.now });
    for (let i = 0; i < 5; i++) bucket.take();

    clock.advance(300); // 3 tokens regenerated (10/s × 0.3s)
    expect(bucket.pendingWaitMs()).toBe(0);
    bucket.take();
    bucket.take();
    bucket.take();
    expect(bucket.pendingWaitMs()).toBeGreaterThan(0);
  });

  it('caps refilled tokens at burst capacity', () => {
    const clock = makeClock(0);
    const bucket = new TokenBucket({ tokensPerSecond: 10, burst: 3, now: clock.now });
    bucket.take();
    clock.advance(100_000); // huge idle
    // can still only take burst tokens before hitting wait
    bucket.take();
    bucket.take();
    bucket.take();
    expect(bucket.pendingWaitMs()).toBeGreaterThan(0);
  });

  it('take() throws if called when empty (caller must await pendingWaitMs)', () => {
    const clock = makeClock(0);
    const bucket = new TokenBucket({ tokensPerSecond: 4, burst: 1, now: clock.now });
    bucket.take();
    expect(() => bucket.take()).toThrow(/no tokens/i);
  });

  it('rejects invalid config', () => {
    expect(() => new TokenBucket({ tokensPerSecond: 0, burst: 1 })).toThrow();
    expect(() => new TokenBucket({ tokensPerSecond: 1, burst: 0 })).toThrow();
    expect(() => new TokenBucket({ tokensPerSecond: -1, burst: 1 })).toThrow();
  });
});
