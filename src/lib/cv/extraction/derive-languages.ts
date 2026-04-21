/**
 * `deriveLanguages` — derives `candidate_languages` from
 * `candidate_extractions.raw_output.languages[]`. Service layer;
 * I/O is injected (mirror of `./derive-experiences`).
 *
 * Stub for [RED] step — GREEN implementation lands in the next commit.
 */
import type { ExtractionResult } from './types';

export interface LanguageInsertRow {
  candidate_id: string;
  extraction_id: string;
  name: string;
  level: string | null;
}

export interface DeriveLanguagesDeps {
  loadExtraction: (id: string) => Promise<{
    candidate_id: string;
    raw_output: ExtractionResult;
  } | null>;
  hasExistingLanguages: (extractionId: string) => Promise<boolean>;
  insertLanguages: (rows: LanguageInsertRow[]) => Promise<number>;
}

export interface DeriveLanguagesResult {
  skipped: boolean;
  languagesInserted: number;
}

export async function deriveLanguages(
  _extractionId: string,
  _deps: DeriveLanguagesDeps,
): Promise<DeriveLanguagesResult> {
  throw new Error('deriveLanguages: not implemented (RED)');
}
