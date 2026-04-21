/**
 * Stub — real impl in GREEN.
 */
import type { ExtractionProvider } from './provider';
import type { ExtractionResult, SourceVariant } from './types';

export interface CvExtractionWorkerDeps {
  listPending: (limit: number) => Promise<
    Array<{
      file_id: string;
      candidate_id: string;
      parsed_text: string;
    }>
  >;
  extractionExistsByHash: (hash: string) => Promise<boolean>;
  insertExtraction: (row: {
    candidate_id: string;
    file_id: string;
    source_variant: SourceVariant;
    model: string;
    prompt_version: string;
    content_hash: string;
    raw_output: ExtractionResult;
  }) => Promise<void>;
  logRowError: (input: {
    entity: 'cv_extraction';
    entity_id: string;
    message: string;
  }) => Promise<void>;
  provider: ExtractionProvider;
  now?: () => Date;
}

export interface CvExtractionRunOptions {
  batchSize?: number;
}

export interface CvExtractionRunResult {
  processed: number;
  extracted: number;
  skipped: number;
  errored: number;
}

export async function runCvExtractions(
  _deps: CvExtractionWorkerDeps,
  _options: CvExtractionRunOptions = {},
): Promise<CvExtractionRunResult> {
  return { processed: 0, extracted: 0, skipped: 0, errored: 0 };
}
