/**
 * Stub — real provider in GREEN commit.
 */
import type { ExtractionProvider } from '../provider';
import type { ExtractionResult } from '../types';

export interface OpenAiExtractionProviderOptions {
  apiKey: string;
  model: string;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export function createOpenAiExtractionProvider(
  _options: OpenAiExtractionProviderOptions,
): ExtractionProvider {
  return {
    model: 'STUB',
    promptVersion: 'STUB',
    extract(): Promise<ExtractionResult> {
      throw new Error('stub not implemented');
    },
  };
}
