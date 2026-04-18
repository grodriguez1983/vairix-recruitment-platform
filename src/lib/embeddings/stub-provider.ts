/**
 * Deterministic stub provider for tests.
 * Stub — [GREEN] commit fills it in.
 */
import type { EmbeddingProvider } from './provider';

export interface StubProviderOptions {
  model?: string;
  dim?: number;
}

export function createStubProvider(_options?: StubProviderOptions): EmbeddingProvider {
  throw new Error('not implemented');
}
