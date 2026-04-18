/**
 * OpenAI embedding provider (ADR-005).
 *
 * Thin wrapper around the `/v1/embeddings` REST endpoint. We don't
 * pull in the `openai` npm package: one endpoint + one body shape
 * + an auth header is easier to debug than an SDK surface. Retries
 * and backoff should live one level up (the worker) once we have a
 * real rate-limit footprint.
 *
 * The response may return `data` out of order; we re-align by the
 * `index` field so callers can trust positional correspondence.
 *
 * Vendor lock-in is deliberately limited to this file per ADR-005
 * §Consecuencias. Swapping providers means a new implementation of
 * `EmbeddingProvider`, not changes anywhere else.
 */
import type { EmbeddingProvider } from './provider';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  dim: number;
  baseUrl?: string;
}

interface OpenAiEmbeddingResponse {
  data?: Array<{ index: number; embedding: number[] }>;
}

export function createOpenAiProvider(options: OpenAiProviderOptions): EmbeddingProvider {
  const baseUrl = options.baseUrl ?? 'https://api.openai.com';
  const url = `${baseUrl}/v1/embeddings`;

  return {
    model: options.model,
    dim: options.dim,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: options.model, input: texts }),
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '<unreadable>');
        throw new Error(`OpenAI embeddings failed: ${response.status} ${body}`);
      }

      const parsed = (await response.json()) as OpenAiEmbeddingResponse;
      const data = parsed.data ?? [];
      const out = new Array<number[] | undefined>(texts.length);
      for (const row of data) {
        if (row.index >= 0 && row.index < texts.length) {
          out[row.index] = row.embedding;
        }
      }
      for (let i = 0; i < out.length; i += 1) {
        if (!out[i]) throw new Error(`OpenAI embeddings: missing vector at index ${i}`);
      }
      return out as number[][];
    },
  };
}
