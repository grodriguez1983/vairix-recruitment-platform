/**
 * Retry policy for Teamtailor HTTP requests.
 *
 * Design notes:
 * - `computeBackoff` never sleeps itself; callers combine it with a
 *   scheduler (usually `setTimeout`) and an `AbortSignal`.
 * - Jitter is injected so tests can pass identity and assert exact
 *   values; production uses `defaultRetryPolicy()` which randomizes.
 * - `Retry-After` wins over exponential backoff — if the server tells
 *   us how long to wait, we respect it (capped at `maxDelayMs`).
 */

export interface RetryPolicy {
  /** Maximum number of attempts, inclusive of the first one. */
  maxAttempts: number;
  /** Base delay for the first retry (attempt=1 → baseDelayMs). */
  baseDelayMs: number;
  /** Hard ceiling; both exponential and Retry-After are capped here. */
  maxDelayMs: number;
  /** Applied to the computed delay. Identity for tests; random for prod. */
  jitter: (ms: number) => number;
}

/**
 * 50%–100% jitter on the computed delay: the classic "decorrelated"
 * variant that still respects the upper bound.
 */
function defaultJitter(ms: number): number {
  return Math.round(ms * (0.5 + Math.random() * 0.5));
}

export function defaultRetryPolicy(): RetryPolicy {
  return {
    maxAttempts: 5,
    baseDelayMs: 1_000,
    maxDelayMs: 30_000,
    jitter: defaultJitter,
  };
}

/**
 * Parses the HTTP `Retry-After` header into milliseconds.
 *
 * Accepts:
 *   - numeric seconds (integer or fractional): "5", "0.5"
 *   - absolute HTTP date (RFC 7231): "Wed, 21 Oct 2015 07:28:00 GMT"
 *
 * Returns `undefined` when the header is missing/unparseable, so
 * callers can fall back to exponential backoff.
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (header == null || header === '') return undefined;
  const trimmed = header.trim();
  const asNumber = Number(trimmed);
  if (Number.isFinite(asNumber) && asNumber >= 0) {
    return Math.round(asNumber * 1000);
  }
  const asDate = Date.parse(trimmed);
  if (!Number.isNaN(asDate)) {
    const diff = asDate - Date.now();
    return diff > 0 ? diff : 0;
  }
  return undefined;
}

/**
 * Whether an attempt that returned `status` (or a network failure,
 * signaled by `status === undefined`) should be retried.
 */
export function shouldRetry(
  status: number | undefined,
  attempt: number,
  policy: RetryPolicy,
): boolean {
  if (attempt >= policy.maxAttempts) return false;
  if (status === undefined) return true; // network / DNS / timeout
  if (status === 429) return true;
  if (status >= 500 && status < 600) return true;
  return false;
}

/**
 * Computes the delay before the next attempt.
 *
 * Precedence:
 *   1. If `retryAfterMs` is set and positive → use it (capped).
 *   2. Otherwise exponential: baseDelayMs × 2^(attempt-1), capped.
 * Jitter is applied last so rounding from jitter doesn't break the cap.
 */
export function computeBackoff(
  policy: RetryPolicy,
  attempt: number,
  retryAfterMs?: number,
): number {
  const base =
    retryAfterMs !== undefined && retryAfterMs > 0
      ? retryAfterMs
      : policy.baseDelayMs * 2 ** Math.max(0, attempt - 1);
  const capped = Math.min(base, policy.maxDelayMs);
  return policy.jitter(capped);
}
