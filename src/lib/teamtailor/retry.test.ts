/**
 * Unit tests for retry policy + backoff + Retry-After parsing.
 */
import { describe, expect, it } from 'vitest';
import { computeBackoff, defaultRetryPolicy, parseRetryAfter, shouldRetry } from './retry';

describe('parseRetryAfter', () => {
  it('parses seconds as number', () => {
    expect(parseRetryAfter('5')).toBe(5000);
    expect(parseRetryAfter('0')).toBe(0);
  });

  it('parses fractional seconds', () => {
    expect(parseRetryAfter('0.5')).toBe(500);
  });

  it('parses HTTP date (RFC 7231)', () => {
    // HTTP dates have second-level precision; toUTCString() truncates
    // sub-second. Worst case is ~1s skew if called near a second
    // boundary, so accept any positive value below the target + 1s.
    const future = new Date(Date.now() + 3000).toUTCString();
    const ms = parseRetryAfter(future);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it('returns 0 for past HTTP date', () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBe(0);
  });

  it('returns undefined for missing or unparseable input', () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter(undefined)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('not-a-date')).toBeUndefined();
  });
});

describe('shouldRetry', () => {
  const policy = { ...defaultRetryPolicy(), maxAttempts: 3 };

  it('retries on 429', () => {
    expect(shouldRetry(429, 1, policy)).toBe(true);
  });

  it('retries on 5xx', () => {
    expect(shouldRetry(500, 1, policy)).toBe(true);
    expect(shouldRetry(503, 2, policy)).toBe(true);
  });

  it('retries on undefined status (network/DNS failure)', () => {
    expect(shouldRetry(undefined, 1, policy)).toBe(true);
  });

  it('does not retry on persistent 4xx', () => {
    expect(shouldRetry(400, 1, policy)).toBe(false);
    expect(shouldRetry(401, 1, policy)).toBe(false);
    expect(shouldRetry(403, 1, policy)).toBe(false);
    expect(shouldRetry(404, 1, policy)).toBe(false);
  });

  it('does not retry after maxAttempts', () => {
    expect(shouldRetry(429, 3, policy)).toBe(false);
    expect(shouldRetry(500, 4, policy)).toBe(false);
  });

  it('does not retry on 2xx (unreachable but sanity)', () => {
    expect(shouldRetry(200, 1, policy)).toBe(false);
  });
});

describe('computeBackoff', () => {
  // Deterministic jitter: identity (no randomness) for these tests.
  const policy = {
    maxAttempts: 5,
    baseDelayMs: 1000,
    maxDelayMs: 30_000,
    jitter: (ms: number) => ms,
  };

  it('grows exponentially with attempt', () => {
    expect(computeBackoff(policy, 1)).toBe(1000);
    expect(computeBackoff(policy, 2)).toBe(2000);
    expect(computeBackoff(policy, 3)).toBe(4000);
    expect(computeBackoff(policy, 4)).toBe(8000);
  });

  it('caps at maxDelayMs', () => {
    expect(computeBackoff(policy, 10)).toBe(30_000);
  });

  it('honors Retry-After when provided (overrides exponential)', () => {
    // even on attempt 4 (would be 8000), retryAfter 500ms wins
    expect(computeBackoff(policy, 4, 500)).toBe(500);
  });

  it('Retry-After also capped at maxDelayMs', () => {
    expect(computeBackoff(policy, 1, 99_999)).toBe(30_000);
  });

  it('applies jitter function to the computed delay', () => {
    const halved = { ...policy, jitter: (ms: number) => ms / 2 };
    expect(computeBackoff(halved, 3)).toBe(2000); // 4000/2
  });
});
