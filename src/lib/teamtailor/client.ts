/**
 * Teamtailor HTTP client.
 *
 * Thin orchestrator that composes:
 *   - auth headers (Authorization / X-Api-Version / Accept)
 *   - a global token-bucket rate limiter (shared across all requests)
 *   - a retry policy (429 + 5xx + network failure, honoring Retry-After)
 *   - JSON:API response parsing
 *
 * Timing dependencies (`now`, `sleep`, `fetch`) are injectable so the
 * test suite can run with a virtual clock and MSW without real waits.
 */
import { HttpError, ParseError, TeamtailorError } from './errors';
import { parseDocument } from './parse';
import { paginate, type FetchPage } from './paginate';
import { paginateWithIncluded, type PrimaryWithIncluded } from './paginate-with-included';
import { TokenBucket } from './rate-limit';
import {
  computeBackoff,
  defaultRetryPolicy,
  parseRetryAfter,
  shouldRetry,
  type RetryPolicy,
} from './retry';
import type { TTJsonApiDocument, TTParsedDocument, TTParsedResource } from './types';

const DEFAULT_BASE_URL = 'https://api.teamtailor.com/v1';
const DEFAULT_RATE_LIMIT = { tokensPerSecond: 4, burst: 10 };

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

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new TeamtailorError('aborted', { reason: signal.reason }));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new TeamtailorError('aborted', { reason: signal?.reason }));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export class TeamtailorClient {
  private readonly apiKey: string;
  private readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly bucket: TokenBucket;
  private readonly retry: RetryPolicy;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly signal?: AbortSignal;

  constructor(opts: TeamtailorClientOptions) {
    if (!opts.apiKey) throw new Error('apiKey is required');
    if (!opts.apiVersion) throw new Error('apiVersion is required');
    this.apiKey = opts.apiKey;
    this.apiVersion = opts.apiVersion;
    this.baseUrl = (opts.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, '');
    const rl = opts.rateLimit ?? DEFAULT_RATE_LIMIT;
    this.bucket = new TokenBucket({
      tokensPerSecond: rl.tokensPerSecond,
      burst: rl.burst,
      now: opts.now,
    });
    this.retry = opts.retry ?? defaultRetryPolicy();
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.sleep = opts.sleep ?? defaultSleep;
    this.signal = opts.signal;
  }

  /**
   * Fetches a single JSON:API document from `path` (relative to
   * baseUrl) and returns it parsed. Retries on 429/5xx/network.
   */
  async get<A = Record<string, unknown>>(
    path: string,
    params?: Record<string, string>,
  ): Promise<TTParsedDocument<A>> {
    const url = this.buildUrl(path, params);
    return this.getAbsolute<A>(url);
  }

  /**
   * Lazy async iterator over every resource across pages. Uses
   * `paginate()` under the hood; subsequent pages are fetched
   * through the same retry + rate-limit pipeline.
   */
  paginate<A = Record<string, unknown>>(
    path: string,
    params?: Record<string, string>,
  ): AsyncIterable<TTParsedResource<A>> {
    const initialUrl = this.buildUrl(path, params);
    const fetchPage: FetchPage<A> = (url) => this.getAbsolute<A>(url);
    return paginate<A>(fetchPage, initialUrl);
  }

  /**
   * Lazy async iterator that preserves the JSON:API `included` array
   * alongside each primary resource. Required by syncers that
   * sideload resources (ADR-010 §2). Uses the same retry +
   * rate-limit pipeline as `paginate()`.
   */
  paginateWithIncluded<A = Record<string, unknown>>(
    path: string,
    params?: Record<string, string>,
  ): AsyncIterable<PrimaryWithIncluded<A>> {
    const initialUrl = this.buildUrl(path, params);
    const fetchPage: FetchPage<A> = (url) => this.getAbsolute<A>(url);
    return paginateWithIncluded<A>(fetchPage, initialUrl);
  }

  private buildUrl(path: string, params?: Record<string, string>): string {
    const clean = path.startsWith('/') ? path : `/${path}`;
    const url = new URL(`${this.baseUrl}${clean}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        url.searchParams.set(k, v);
      }
    }
    return url.toString();
  }

  private headers(): HeadersInit {
    return {
      Authorization: `Token token=${this.apiKey}`,
      'X-Api-Version': this.apiVersion,
      Accept: 'application/vnd.api+json',
    };
  }

  /**
   * Executes the request against an already-resolved absolute URL.
   * This is the single seam through which `get()` and paginated
   * follow-ups both flow, so retry/rate-limit apply uniformly.
   */
  private async getAbsolute<A>(url: string): Promise<TTParsedDocument<A>> {
    let attempt = 0;

    while (true) {
      attempt += 1;
      const waitMs = this.bucket.pendingWaitMs();
      if (waitMs > 0) await this.sleep(waitMs, this.signal);
      this.bucket.take();

      let status: number | undefined;
      let retryAfterHeader: string | null = null;
      let body: unknown;
      try {
        const res = await this.fetchImpl(url, {
          method: 'GET',
          headers: this.headers(),
          signal: this.signal,
        });
        status = res.status;
        retryAfterHeader = res.headers.get('retry-after');
        if (res.ok) {
          try {
            body = await res.json();
          } catch (e) {
            throw new ParseError('invalid JSON body', { url, cause: String(e) });
          }
          try {
            const parsed = parseDocument(body as TTJsonApiDocument);
            return parsed as unknown as TTParsedDocument<A>;
          } catch (e) {
            if (e instanceof ParseError) throw e;
            throw new ParseError('failed to parse JSON:API document', { url, cause: String(e) });
          }
        }
      } catch (e) {
        // Network / DNS / abort / parse — if parse, rethrow immediately.
        if (e instanceof ParseError) throw e;
        if (e instanceof TeamtailorError) throw e;
        if (!shouldRetry(undefined, attempt, this.retry)) {
          throw new TeamtailorError('network error', { url, cause: String(e) });
        }
        const delay = computeBackoff(this.retry, attempt);
        await this.sleep(delay, this.signal);
        continue;
      }

      // Non-2xx reached here; decide whether to retry.
      if (status !== undefined && !shouldRetry(status, attempt, this.retry)) {
        throw new HttpError(status, `HTTP ${status} for ${url}`, { url });
      }
      const retryAfterMs = parseRetryAfter(retryAfterHeader);
      const delay = computeBackoff(this.retry, attempt, retryAfterMs);
      await this.sleep(delay, this.signal);
    }
  }
}
