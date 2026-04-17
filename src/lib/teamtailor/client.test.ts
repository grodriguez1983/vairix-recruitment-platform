/**
 * Integration-ish tests for TeamtailorClient using MSW as the
 * HTTP boundary. No real network, but we go through the full
 * fetch → retry → rate-limit → parse pipeline.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { HttpError } from './errors';
import { TeamtailorClient, type TeamtailorClientOptions } from './client';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  '..',
  'tests',
  'fixtures',
  'teamtailor',
);
const page1 = JSON.parse(readFileSync(path.join(fixturesDir, 'candidates-page-1.json'), 'utf-8'));
const page2 = JSON.parse(readFileSync(path.join(fixturesDir, 'candidates-page-2.json'), 'utf-8'));
const page3 = JSON.parse(readFileSync(path.join(fixturesDir, 'candidates-page-3.json'), 'utf-8'));

const BASE_URL = 'https://api.teamtailor.com/v1';
const API_KEY = 'test-key-xxx';
const API_VERSION = '20240904';

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

/**
 * Deterministic virtual clock + sleep. `sleep(n)` advances `now` by
 * n ms so the token bucket (which reads `now()`) sees time pass
 * without us actually waiting.
 */
function makeVirtualClock() {
  let t = 0;
  const now = () => t;
  const sleep = vi.fn(async (ms: number) => {
    t += ms;
  });
  return { now, sleep, advance: (ms: number) => (t += ms) };
}

function makeClient(overrides: Partial<TeamtailorClientOptions> = {}) {
  const clock = makeVirtualClock();
  const client = new TeamtailorClient({
    apiKey: API_KEY,
    apiVersion: API_VERSION,
    baseUrl: BASE_URL,
    rateLimit: { tokensPerSecond: 4, burst: 10 },
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
  return { client, clock };
}

describe('TeamtailorClient — request construction', () => {
  it('sends required auth/version/accept headers', async () => {
    const seen: Headers[] = [];
    server.use(
      http.get(`${BASE_URL}/candidates`, ({ request }) => {
        seen.push(request.headers);
        return HttpResponse.json(page3);
      }),
    );
    const { client } = makeClient();
    await client.get('/candidates');
    expect(seen).toHaveLength(1);
    const h = seen[0]!;
    expect(h.get('authorization')).toBe(`Token token=${API_KEY}`);
    expect(h.get('x-api-version')).toBe(API_VERSION);
    expect(h.get('accept')).toBe('application/vnd.api+json');
  });

  it('serializes query params', async () => {
    let seenUrl = '';
    server.use(
      http.get(`${BASE_URL}/candidates`, ({ request }) => {
        seenUrl = request.url;
        return HttpResponse.json(page3);
      }),
    );
    const { client } = makeClient();
    await client.get('/candidates', {
      'filter[updated-at][from]': '2026-01-01',
      'page[size]': '30',
    });
    const u = new URL(seenUrl);
    expect(u.searchParams.get('filter[updated-at][from]')).toBe('2026-01-01');
    expect(u.searchParams.get('page[size]')).toBe('30');
  });
});

describe('TeamtailorClient — retry behavior', () => {
  it('retries on 429 honoring Retry-After then succeeds', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/candidates`, () => {
        calls++;
        if (calls === 1) {
          return new HttpResponse(null, { status: 429, headers: { 'Retry-After': '2' } });
        }
        return HttpResponse.json(page3);
      }),
    );
    const { client, clock } = makeClient({
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 30_000, jitter: (ms: number) => ms },
    });
    const doc = await client.get('/candidates');
    expect(calls).toBe(2);
    expect(doc.data).toHaveLength(1);
    // Retry-After: 2 → 2000 ms; with identity jitter the sleep must
    // record exactly 2000 (overriding the 100 ms exponential base).
    const sleepCalls = clock.sleep.mock.calls.map((c) => c[0] as number);
    expect(sleepCalls).toContain(2000);
  });

  it('retries transient 5xx with exponential backoff', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/candidates`, () => {
        calls++;
        if (calls < 3) return new HttpResponse(null, { status: 503 });
        return HttpResponse.json(page3);
      }),
    );
    const { client, clock } = makeClient({
      retry: { maxAttempts: 5, baseDelayMs: 100, maxDelayMs: 5000, jitter: (ms: number) => ms },
    });
    await client.get('/candidates');
    expect(calls).toBe(3);
    // expected sleeps: ~100ms (attempt 1→2), ~200ms (attempt 2→3)
    const sleepMs = clock.sleep.mock.calls.map((c) => c[0]).filter((ms) => ms >= 50);
    expect(sleepMs).toEqual(expect.arrayContaining([100, 200]));
  });

  it('does not retry persistent 4xx; throws HttpError', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/candidates/missing`, () => {
        calls++;
        return new HttpResponse(JSON.stringify({ errors: [{ detail: 'not found' }] }), {
          status: 404,
          headers: { 'content-type': 'application/vnd.api+json' },
        });
      }),
    );
    const { client } = makeClient();
    await expect(client.get('/candidates/missing')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(1);
  });

  it('throws HttpError after exhausting retries on persistent 5xx', async () => {
    let calls = 0;
    server.use(
      http.get(`${BASE_URL}/candidates`, () => {
        calls++;
        return new HttpResponse(null, { status: 500 });
      }),
    );
    const { client } = makeClient({
      retry: { maxAttempts: 3, baseDelayMs: 10, maxDelayMs: 100, jitter: (ms: number) => ms },
    });
    await expect(client.get('/candidates')).rejects.toBeInstanceOf(HttpError);
    expect(calls).toBe(3);
  });
});

describe('TeamtailorClient — pagination', () => {
  it('walks links.next through all pages and yields every resource', async () => {
    server.use(
      http.get(`${BASE_URL}/candidates`, ({ request }) => {
        const u = new URL(request.url);
        const num = u.searchParams.get('page[number]') ?? '1';
        if (num === '1') return HttpResponse.json(page1);
        if (num === '2') return HttpResponse.json(page2);
        if (num === '3') return HttpResponse.json(page3);
        return new HttpResponse(null, { status: 400 });
      }),
    );
    const { client } = makeClient();
    const ids: string[] = [];
    for await (const r of client.paginate('/candidates', { 'page[number]': '1' })) {
      ids.push(r.id);
    }
    expect(ids).toEqual(['1001', '1002', '1003', '1004', '1005']);
  });
});

describe('TeamtailorClient — rate limiting', () => {
  it('respects the global bucket across back-to-back calls', async () => {
    server.use(http.get(`${BASE_URL}/candidates`, () => HttpResponse.json(page3)));
    // 4 rps, burst 10: first 10 instant, then 10 more at ~250 ms each
    const { client, clock } = makeClient({
      rateLimit: { tokensPerSecond: 4, burst: 10 },
    });
    for (let i = 0; i < 20; i++) {
      await client.get('/candidates');
    }
    const totalSleptMs = clock.sleep.mock.calls.reduce((acc, c) => acc + (c[0] as number), 0);
    // The last 10 requests each need ~250ms. Expect total sleep in a
    // reasonable band — not zero (proves bucket kicked in), not crazy.
    expect(totalSleptMs).toBeGreaterThanOrEqual(2000);
    expect(totalSleptMs).toBeLessThan(4000);
  });
});
