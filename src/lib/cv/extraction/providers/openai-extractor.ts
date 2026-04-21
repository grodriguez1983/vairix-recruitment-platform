/**
 * OpenAI `ExtractionProvider` (ADR-012 §3).
 *
 * Single file boundary for the external dependency (mirror of
 * `createOpenAiProvider` in `src/lib/embeddings/openai-provider.ts`).
 * Swapping providers means a new implementation of
 * `ExtractionProvider`, nothing else changes.
 *
 * Flow:
 *   - Empty input short-circuits (no API call, empty result).
 *   - POST `/v1/chat/completions` with system prompt + user CV.
 *   - `response_format: { type: 'json_schema' }` forces the shape
 *     server-side — and we re-validate via Zod locally.
 *   - Failures raise; the worker catches and logs to `sync_errors`.
 *
 * `fetchImpl` is injected for unit tests; default is global `fetch`.
 */
import { EXTRACTION_PROMPT_V1, EXTRACTION_PROMPT_V1_TEXT } from '../prompts/extract-v1';
import type { ExtractionProvider } from '../provider';
import { ExtractionResultSchema, type ExtractionResult } from '../types';

export interface OpenAiExtractionProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

// JSON Schema handed to OpenAI as `response_format.json_schema.schema`.
// Keep in sync with `ExtractionResultSchema` in ../types.ts — if the
// two drift, the server-side shape will differ from the local Zod
// validator and we'll reject responses that OpenAI thought were fine.
const RESPONSE_JSON_SCHEMA = {
  name: 'ExtractionResult',
  strict: true,
  schema: {
    type: 'object',
    additionalProperties: false,
    required: ['source_variant', 'experiences', 'languages'],
    properties: {
      source_variant: { type: 'string', enum: ['linkedin_export', 'cv_primary'] },
      experiences: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['kind', 'company', 'title', 'start_date', 'end_date', 'description', 'skills'],
          properties: {
            kind: { type: 'string', enum: ['work', 'side_project', 'education'] },
            company: { type: ['string', 'null'] },
            title: { type: ['string', 'null'] },
            start_date: { type: ['string', 'null'] },
            end_date: { type: ['string', 'null'] },
            description: { type: ['string', 'null'] },
            skills: { type: 'array', items: { type: 'string' } },
          },
        },
      },
      languages: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'level'],
          properties: {
            name: { type: 'string' },
            level: { type: ['string', 'null'] },
          },
        },
      },
    },
  },
};

const EMPTY_RESULT: ExtractionResult = {
  source_variant: 'cv_primary',
  experiences: [],
  languages: [],
};

interface ChatCompletionsResponse {
  choices?: Array<{
    message?: {
      role?: string;
      content?: string | null;
    };
  }>;
}

export function createOpenAiExtractionProvider(
  options: OpenAiExtractionProviderOptions,
): ExtractionProvider {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com';
  const url = `${baseUrl}/v1/chat/completions`;
  const fetchImpl = options.fetchImpl ?? fetch;

  return {
    model: options.model,
    promptVersion: EXTRACTION_PROMPT_V1,

    async extract(parsedText: string): Promise<ExtractionResult> {
      if (parsedText.length === 0) {
        return EMPTY_RESULT;
      }

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
            { role: 'system', content: EXTRACTION_PROMPT_V1_TEXT },
            { role: 'user', content: parsedText },
          ],
        }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new Error(`OpenAI extraction failed: ${response.status} ${body}`);
      }

      const payload = (await response.json()) as ChatCompletionsResponse;
      const content = payload.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.length === 0) {
        throw new Error('OpenAI extraction: missing message.content');
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(content);
      } catch (e) {
        throw new Error(
          `OpenAI extraction: response was not valid JSON (${e instanceof Error ? e.message : 'unknown'})`,
        );
      }

      return ExtractionResultSchema.parse(parsed);
    },
  };
}
