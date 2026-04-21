/**
 * Stub — real interface lands in GREEN.
 */
import type { ExtractionResult } from './types';

export interface ExtractionProvider {
  readonly model: string;
  readonly promptVersion: string;
  extract(parsedText: string): Promise<ExtractionResult>;
}
