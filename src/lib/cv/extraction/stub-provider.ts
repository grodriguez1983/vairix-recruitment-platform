/**
 * Stub — will be replaced by deterministic stub in GREEN.
 */
import type { ExtractionProvider } from './provider';
import type { ExtractionResult } from './types';

export interface StubExtractionProviderOptions {
  model?: string;
  promptVersion?: string;
  fixture?: ExtractionResult;
}

export function createStubExtractionProvider(
  _options: StubExtractionProviderOptions = {},
): ExtractionProvider {
  return {
    model: 'STUB',
    promptVersion: 'STUB',
    extract(): Promise<ExtractionResult> {
      throw new Error('stub not implemented');
    },
  };
}
