/**
 * Teamtailor HTTP client.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { RetryPolicy } from './retry';
import type { TTParsedDocument, TTParsedResource } from './types';

export interface TeamtailorClientOptions {
  /** API token (sent as `Authorization: Token token=<apiKey>`). */
  apiKey: string;
  /** Value for the required `X-Api-Version` header. */
  apiVersion: string;
  /** Base URL without trailing slash (default: https://api.teamtailor.com/v1). */
  baseUrl?: string;
  /** Rate limit (default: 4 rps, burst 10). */
  rateLimit?: { tokensPerSecond: number; burst: number };
  /** Retry policy (default: `defaultRetryPolicy()`). */
  retry?: RetryPolicy;
  /** Fetch impl. Injectable for tests. Defaults to global fetch. */
  fetch?: typeof fetch;
  /** Monotonic clock for the rate-limit bucket. */
  now?: () => number;
  /** Sleep primitive; injectable so tests can run without real timers. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Optional abort signal to cancel in-flight operations. */
  signal?: AbortSignal;
}

export class TeamtailorClient {
  constructor(_opts: TeamtailorClientOptions) {
    void _opts;
    throw new Error('TeamtailorClient: not implemented');
  }

  async get<A = Record<string, unknown>>(
    _path: string,
    _params?: Record<string, string>,
  ): Promise<TTParsedDocument<A>> {
    void _path;
    void _params;
    throw new Error('get: not implemented');
  }

  paginate<A = Record<string, unknown>>(
    _path: string,
    _params?: Record<string, string>,
  ): AsyncIterable<TTParsedResource<A>> {
    void _path;
    void _params;
    throw new Error('paginate: not implemented');
  }
}
