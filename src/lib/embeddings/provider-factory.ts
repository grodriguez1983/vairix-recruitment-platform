/**
 * Resolve an EmbeddingProvider from environment.
 *
 * Centralizes the env-reading / fallback logic that scripts and API
 * routes share. Caller can pass `useStub: true` to bypass OpenAI
 * entirely (CLI smoke tests, integration tests). Otherwise requires
 * `OPENAI_API_KEY`.
 *
 * Env vars:
 *   - OPENAI_API_KEY     (required unless useStub)
 *   - EMBEDDINGS_MODEL   (optional, default: text-embedding-3-small)
 */
import { createOpenAiProvider } from './openai-provider';
import type { EmbeddingProvider } from './provider';
import { createStubProvider } from './stub-provider';

export const DEFAULT_EMBEDDINGS_MODEL = 'text-embedding-3-small';
export const EMBEDDINGS_DIM = 1536;

export interface ResolveProviderOptions {
  useStub?: boolean;
}

export function resolveEmbeddingProvider(options: ResolveProviderOptions = {}): EmbeddingProvider {
  if (options.useStub) {
    return createStubProvider({ model: 'stub-cli', dim: EMBEDDINGS_DIM });
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || apiKey.length === 0) {
    throw new Error('OPENAI_API_KEY missing');
  }
  const model = process.env.EMBEDDINGS_MODEL ?? DEFAULT_EMBEDDINGS_MODEL;
  return createOpenAiProvider({ apiKey, model, dim: EMBEDDINGS_DIM });
}
