/**
 * CV parse worker runtime — RED stub (awaiting GREEN impl).
 */
import type { CvParseErrorCode, CvParserDeps } from './parse';

export interface CvParseWorkerDeps {
  listPending: (
    limit: number,
  ) => Promise<Array<{ id: string; storage_path: string; file_type: string }>>;
  download: (storagePath: string) => Promise<Buffer>;
  update: (
    id: string,
    patch: {
      parsed_text: string | null;
      parse_error: CvParseErrorCode | null;
      parsed_at: string;
    },
  ) => Promise<void>;
  parser: CvParserDeps;
  now?: () => Date;
}

export interface CvParseRunOptions {
  batchSize?: number;
}

export interface CvParseRunResult {
  processed: number;
  parsed: number;
  errored: number;
}

export async function runCvParseWorker(
  _deps: CvParseWorkerDeps,
  _options: CvParseRunOptions = {},
): Promise<CvParseRunResult> {
  throw new Error('not implemented (RED)');
}
