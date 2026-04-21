/**
 * OpenAI `DecompositionProvider` (ADR-014 §3).
 *
 * Mirror of `createOpenAiExtractionProvider` (ADR-012 §3). Single
 * file boundary for the external dependency; swapping providers
 * means a new implementation of `DecompositionProvider` and nothing
 * else changes.
 *
 * Flow:
 *   - POST `/v1/chat/completions` with system prompt + user raw_text.
 *   - `response_format: { type: 'json_schema' }` forces the shape
 *     server-side, and we re-validate via Zod locally.
 *   - Failures raise; the service maps them to `DecompositionError`.
 *
 * `fetchImpl` is injected for unit tests; default is global `fetch`.
 */
import { DECOMPOSITION_PROMPT_V1, DECOMPOSITION_PROMPT_V1_TEXT } from '../prompts/decompose-v1';
import type { DecompositionProvider } from '../provider';
import { DecompositionResultSchema, type DecompositionResult } from '../types';

export interface OpenAiDecompositionProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// JSON Schema handed to OpenAI as `response_format.json_schema.schema`.
// Keep in sync with `DecompositionResultSchema` in ../types.ts — if the
// two drift, the server-side shape will differ from the local Zod
// validator and we'll reject responses that OpenAI thought were fine.
const RESPONSE_JSON_SCHEMA = {
  name: 'DecompositionResult',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['requirements', 'seniority', 'languages', 'notes'],
    properties: {
      requirements: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: [
            'skill_raw',
            'min_years',
            'max_years',
            'must_have',
            'evidence_snippet',
            'category',
          ],
          properties: {
            skill_raw: { type: 'string' },
            min_years: { type: ['integer', 'null'], minimum: 0 },
            max_years: { type: ['integer', 'null'], minimum: 0 },
            must_have: { type: 'boolean' },
            evidence_snippet: { type: 'string' },
            category: {
              type: 'string',
              enum: ['technical', 'language', 'soft', 'other'],
            },
          },
        },
      },
      seniority: {
        type: 'string',
        enum: ['junior', 'semi_senior', 'senior', 'lead', 'unspecified'],
      },
      languages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'level', 'must_have'],
          properties: {
            name: { type: 'string' },
            level: {
              type: 'string',
              enum: ['basic', 'intermediate', 'advanced', 'native', 'unspecified'],
            },
            must_have: { type: 'boolean' },
          },
        },
      },
      notes: { type: ['string', 'null'] },
    },
  },
};

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
    };
  }>;
}

export function createOpenAiDecompositionProvider(
  options: OpenAiDecompositionProviderOptions,
): DecompositionProvider {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com';
  const url = `${baseUrl}/v1/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    model: options.model,
    promptVersion: DECOMPOSITION_PROMPT_V1,

    async decompose(rawText: string): Promise<DecompositionResult> {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: options.model,
          response_format: { type: 'json_schema', json_schema: RESPONSE_JSON_SCHEMA },
          messages: [
            { role: 'system', content: DECOMPOSITION_PROMPT_V1_TEXT },
            { role: 'user', content: rawText },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new Error(`OpenAI decomposition failed: ${response.status} ${body}`);
      }

      const payload = (await response.json()) as ChatCompletionsResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('OpenAI decomposition: missing message.content');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        throw new Error(
          `OpenAI decomposition: response was not valid JSON (${e instanceof Error ? e.message : 'unknown'})`,
        );
      }

      return DecompositionResultSchema.parse(parsed);
    },
  };
}
