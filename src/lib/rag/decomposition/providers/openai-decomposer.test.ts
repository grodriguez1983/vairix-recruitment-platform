/**
 * Unit tests for `createOpenAiDecompositionProvider` (ADR-014 §3).
 *
 * The provider is the only place that talks to OpenAI for
 * decomposition. We test it with an injected `fetch` stub — no real
 * network. Contract:
 *
 *   - Posts to `/v1/chat/completions` with configured model and
 *     `response_format: { type: 'json_schema' }`.
 *   - System message carries the prompt, user message the raw_text.
 *   - Returns a Zod-valid `DecompositionResult` from
 *     `choices[0].message.content`.
 *   - Throws on non-2xx so the service can map to
 *     `DecompositionError(provider_failure)`.
 *   - Throws on content that fails the Zod parse (schema_violation
 *     signal for the service).
 *   - `promptVersion` comes from the prompt file (hash invariant).
 */
import { describe, expect, it, vi } from 'vitest';

import { createOpenAiDecompositionProvider } from './openai-decomposer';
import type { DecompositionResult } from '../types';

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

function validResult(): DecompositionResult {
  return {
    requirements: [
      {
        skill_raw: 'Node.js',
        min_years: 3,
        max_years: null,
        must_have: true,
        evidence_snippet: '3+ años de Node.js',
        category: 'technical',
        alternative_group_id: null,
      },
    ],
    seniority: 'senior',
    languages: [{ name: 'English', level: 'intermediate', must_have: false }],
    notes: null,
    role_essentials: [],
  };
}

function wrapOpenAi(content: unknown): Record<string, unknown> {
  return {
    choices: [{ message: { role: 'assistant', content: JSON.stringify(content) } }],
  };
}

describe('createOpenAiDecompositionProvider — ADR-014 §3', () => {
  it('exposes model and promptVersion (pinned via prompt file)', () => {
    const fetchImpl = fetchStub(wrapOpenAi(validResult()));
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    expect(p.model).toBe('gpt-4o-mini');
    expect(p.promptVersion).toMatch(/^20\d{2}-/);
  });

  it('POSTs to /v1/chat/completions with model + response_format', async () => {
    const fetchImpl = fetchStub(wrapOpenAi(validResult()));
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await p.decompose('Buscamos backend sr con 3+ años Node.js');
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const [url, init] = call as [string, RequestInit];
    expect(url).toContain('/v1/chat/completions');
    const body = JSON.parse(init.body as string) as Record<string, unknown>;
    expect(body.model).toBe('gpt-4o-mini');
    expect(body.response_format).toMatchObject({ type: 'json_schema' });
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0]?.role).toBe('system');
    expect(messages[1]?.role).toBe('user');
    expect(messages[1]?.content).toBe('Buscamos backend sr con 3+ años Node.js');
  });

  it('returns a Zod-valid DecompositionResult from choices[0].message.content', async () => {
    const expected = validResult();
    const fetchImpl = fetchStub(wrapOpenAi(expected));
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    const out = await p.decompose('some text');
    expect(out).toEqual(expected);
  });

  it('throws on HTTP non-2xx', async () => {
    const fetchImpl = fetchStub({ error: { message: 'rate_limited' } }, 429);
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.decompose('some text')).rejects.toThrow(/429/);
  });

  it('throws when message.content is missing', async () => {
    const fetchImpl = fetchStub({ choices: [{ message: { role: 'assistant' } }] });
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.decompose('some text')).rejects.toThrow();
  });

  it('throws when content is not valid JSON', async () => {
    const fetchImpl = fetchStub({
      choices: [{ message: { role: 'assistant', content: 'not json at all' } }],
    });
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.decompose('some text')).rejects.toThrow();
  });

  it('throws when returned JSON fails the Zod schema', async () => {
    const invalid = {
      requirements: [
        {
          // missing min_years/max_years
          skill_raw: 'Go',
          must_have: true,
          evidence_snippet: '5 años Go',
          category: 'technical',
          alternative_group_id: null,
        },
      ],
      seniority: 'senior',
      languages: [],
      notes: null,
    };
    const fetchImpl = fetchStub(wrapOpenAi(invalid));
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await expect(p.decompose('some text')).rejects.toThrow();
  });

  it('sends Authorization header with bearer token', async () => {
    const fetchImpl = fetchStub(wrapOpenAi(validResult()));
    const p = createOpenAiDecompositionProvider({
      apiKey: 'sk-test-abc',
      model: 'gpt-4o-mini',
      fetchImpl,
    });
    await p.decompose('some text');
    const call = (fetchImpl as unknown as { mock: { calls: unknown[][] } }).mock.calls[0]!;
    const [, init] = call as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers.authorization ?? headers.Authorization).toBe('Bearer sk-test-abc');
  });
});
