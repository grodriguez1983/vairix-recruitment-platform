/**
 * Unit tests for `createOpenAiExtractionProvider` (ADR-012 §3).
 *
 * The provider is the only place that talks to OpenAI. We test it
 * by injecting a `fetch` stub — no real network. Contract:
 *
 *   - Posts to `/v1/chat/completions` with the configured model and
 *     `response_format: { type: 'json_schema' }`.
 *   - Sends the parsed_text as the user message, the prompt as a
 *     system message.
 *   - Returns a Zod-valid `ExtractionResult` parsed from
 *     `choices[0].message.content`.
 *   - Throws on non-2xx responses (so the worker can catch and log
 *     to sync_errors).
 *   - Throws on content that does not match the Zod schema (guards
 *     against the model returning near-valid JSON despite the
 *     response_format).
 *   - Short-circuits empty input (no API call, returns empty result).
 */
import { describe, expect, it, vi } from 'vitest';

import { createOpenAiExtractionProvider } from './openai-extractor';
import type { ExtractionResult } from '../types';

function fetchStub(responseJson: unknown, status = 200): typeof fetch {
  return vi.fn(async () =>
    Promise.resolve(
      new Response(JSON.stringify(responseJson), {
        status,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  ) as unknown as typeof fetch;
}

function validExtractionResult(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2021-01',
        end_date: null,
        description: null,
        skills: ['TypeScript'],
      },
    ],
    languages: [{ name: 'English', level: 'C1' }],
  };
}

function openAiBodyWrapping(content: unknown): Record<string, unknown> {
  return {
    choices: [
      {
        message: {
          role: 'assistant',
          content: JSON.stringify(content),
        },
      },
    ],
  };
}

describe('createOpenAiExtractionProvider — ADR-012 §3', () => {
  it('exposes model and promptVersion passed in options', () => {
    const fetchImpl = fetchStub(openAiBodyWrapping(validExtractionResult()));
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    expect(p.model).toBe('gpt-4o-mini');
    expect(p.promptVersion).toMatch(/^20\d{2}-/); // pinned via prompt file
  });

  it('sends POST to /v1/chat/completions with the configured model', async () => {
    const fetchImpl = fetchStub(openAiBodyWrapping(validExtractionResult()));
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await p.extract('some parsed cv text');

    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const [url, init] = call as [string, RequestInit];
    expect(url).toContain('/v1/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
    // System prompt carries the instructions; user message carries the CV.
    expect(Array.isArray(body.messages)).toBe(true);
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toBe('some parsed cv text');
  });

  it('returns a Zod-valid ExtractionResult parsed from choices[0].message.content', async () => {
    const expected = validExtractionResult();
    const fetchImpl = fetchStub(openAiBodyWrapping(expected));
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    const out = await p.extract('some cv');
    expect(out).toEqual(expected);
  });

  it('throws on HTTP non-2xx', async () => {
    const fetchImpl = fetchStub({ error: { message: 'rate_limited' } }, 429);
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.extract('some cv')).rejects.toThrow(/429/);
  });

  it('throws when message.content is missing', async () => {
    const fetchImpl = fetchStub({ choices: [{ message: { role: 'assistant' } }] });
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.extract('some cv')).rejects.toThrow();
  });

  it('throws when returned JSON does not match Zod schema', async () => {
    const invalid = { source_variant: 'scanned_pdf', experiences: [], languages: [] };
    const fetchImpl = fetchStub(openAiBodyWrapping(invalid));
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.extract('some cv')).rejects.toThrow();
  });

  it('throws when content is not valid JSON', async () => {
    const fetchImpl = fetchStub({
      choices: [{ message: { role: 'assistant', content: 'not json at all' } }],
    });
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.extract('some cv')).rejects.toThrow();
  });

  it('short-circuits empty input (returns empty result, no API call)', async () => {
    const fetchImpl = fetchStub(openAiBodyWrapping(validExtractionResult()));
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    const out = await p.extract('');
    expect(out.experiences).toEqual([]);
    expect(out.languages).toEqual([]);
    expect((fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls).toHaveLength(0);
  });

  it('sends Authorization header with bearer token', async () => {
    const fetchImpl = fetchStub(openAiBodyWrapping(validExtractionResult()));
    const p = createOpenAiExtractionProvider({
      apiKey: 'sk-test-abc',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await p.extract('some cv');
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const [, init] = call as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization ?? headers.Authorization).toBe('Bearer sk-test-abc');
  });
});
