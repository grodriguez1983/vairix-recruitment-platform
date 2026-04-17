// Stub — implementación en [GREEN].
export interface RetryPolicy {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  jitter: (ms: number) => number;
}
export function defaultRetryPolicy(): RetryPolicy {
  throw new Error('not implemented');
}
export function parseRetryAfter(_header: string | null | undefined): number | undefined {
  throw new Error('not implemented');
}
export function shouldRetry(
  _status: number | undefined,
  _attempt: number,
  _policy: RetryPolicy,
): boolean {
  throw new Error('not implemented');
}
export function computeBackoff(
  _policy: RetryPolicy,
  _attempt: number,
  _retryAfterMs?: number,
): number {
  throw new Error('not implemented');
}
