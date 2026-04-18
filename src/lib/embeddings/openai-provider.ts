/**
 * OpenAI embedding provider — stub. [GREEN] fills it in.
 */
import type { EmbeddingProvider } from './provider';

export interface OpenAiProviderOptions {
  apiKey: string;
  model: string;
  dim: number;
  baseUrl?: string;
}

export function createOpenAiProvider(_options: OpenAiProviderOptions): EmbeddingProvider {
  throw new Error('not implemented');
}
