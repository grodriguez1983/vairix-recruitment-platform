/**
 * Deterministic stub embedding provider.
 *
 * Used by integration tests so the worker can run end-to-end against
 * real Supabase without an OpenAI key. The vector is derived from a
 * SHA-256 of the input text, expanded to `dim` floats in [-1, 1].
 * Two properties we care about for tests:
 *   - Same text ⇒ same vector (hash stability depends on it).
 *   - Different texts ⇒ different vectors with overwhelming prob.
 *
 * The values are NOT a real embedding — they're numerically stable
 * noise. Do not use this provider for any similarity-based behavior.
 */
import { createHash } from 'node:crypto';

import type { EmbeddingProvider } from './provider';

export interface StubProviderOptions {
  model?: string;
  dim?: number;
}

function textToVector(text: string, dim: number): number[] {
  const out = new Array<number>(dim);
  // Expand sha-256 (32 bytes) by re-hashing with a counter until we fill `dim`.
  let filled = 0;
  let counter = 0;
  while (filled < dim) {
    const buf = createHash('sha256').update(text).update('\x00').update(String(counter)).digest();
    for (let i = 0; i < buf.length && filled < dim; i += 1) {
      // Map byte [0,255] → [-1, 1) with 1/256 resolution.
      out[filled] = (buf[i]! - 128) / 128;
      filled += 1;
    }
    counter += 1;
  }
  return out;
}

export function createStubProvider(options: StubProviderOptions = {}): EmbeddingProvider {
  const model = options.model ?? 'stub-v1';
  const dim = options.dim ?? 1536;
  return {
    model,
    dim,
    embed(texts: string[]): Promise<number[][]> {
      return Promise.resolve(texts.map((t) => textToVector(t, dim)));
    },
  };
}
