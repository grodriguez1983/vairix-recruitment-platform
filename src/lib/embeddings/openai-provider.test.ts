/**
 * Unit tests for the OpenAI embedding provider.
 *
 * We stub `globalThis.fetch` to exercise:
 *   - Request shape: POST to the right URL, correct headers, JSON
 *     body with `model` + `input` array.
 *   - Response parsing: vectors returned in input order.
 *   - Error handling: non-2xx ⇒ throws with status + response body.
 *   - Empty input: returns [] without calling fetch (cheap shortcut).
 *
 * No real network. A real-world run is gated on OPENAI_API_KEY and
 * is out of this unit suite.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOpenAiProvider } from './openai-provider';

interface MockCall {
  url: string;
  init: RequestInit;
}

function installFetchMock(handler: (call: MockCall) => Response | Promise<Response>): MockCall[] {
  const calls: MockCall[] = [];
  globalThis.fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call: MockCall = { url: String(input), init: init ?? {} };
    calls.push(call);
    return handler(call);
  }) as typeof fetch;
  return calls;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

describe('createOpenAiProvider', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('posts model + input to the embeddings endpoint with the api key', async () => {
    const calls = installFetchMock(() =>
      jsonResponse({
        data: [
          { index: 0, embedding: [0.1, 0.2] },
          { index: 1, embedding: [0.3, 0.4] },
        ],
      }),
    );
    const p = createOpenAiProvider({
      apiKey: 'sk-test',
      model: 'text-embedding-3-small',
      dim: 2,
    });
    const out = await p.embed(['hello', 'world']);

    expect(out).toEqual([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('https://api.openai.com/v1/embeddings');
    expect(calls[0]?.init.method).toBe('POST');
    const headers = new Headers(calls[0]?.init.headers);
    expect(headers.get('authorization')).toBe('Bearer sk-test');
    expect(headers.get('content-type')).toBe('application/json');
    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body).toEqual({ model: 'text-embedding-3-small', input: ['hello', 'world'] });
  });

  it('reorders vectors by the response `index` field', async () => {
    installFetchMock(() =>
      jsonResponse({
        // Out of order on purpose — the provider must re-align by `index`.
        data: [
          { index: 1, embedding: [2] },
          { index: 0, embedding: [1] },
        ],
      }),
    );
    const p = createOpenAiProvider({ apiKey: 'k', model: 'm', dim: 1 });
    const out = await p.embed(['a', 'b']);
    expect(out).toEqual([[1], [2]]);
  });

  it('throws with status + body when the API returns non-2xx', async () => {
    installFetchMock(
      () =>
        new Response('{"error":{"message":"nope"}}', {
          status: 429,
          headers: { 'content-type': 'application/json' },
        }),
    );
    const p = createOpenAiProvider({ apiKey: 'k', model: 'm', dim: 1 });
    await expect(p.embed(['x'])).rejects.toThrow(/429.*nope/);
  });

  it('short-circuits on empty input without calling fetch', async () => {
    const calls = installFetchMock(() => jsonResponse({ data: [] }));
    const p = createOpenAiProvider({ apiKey: 'k', model: 'm', dim: 1 });
    const out = await p.embed([]);
    expect(out).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('exposes model + dim metadata', () => {
    const p = createOpenAiProvider({
      apiKey: 'k',
      model: 'text-embedding-3-small',
      dim: 1536,
    });
    expect(p.model).toBe('text-embedding-3-small');
    expect(p.dim).toBe(1536);
  });
});
