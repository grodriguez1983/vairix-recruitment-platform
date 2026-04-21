/**
 * `deriveLanguages(extractionId, deps)` — Languages persistence slice.
 *
 * Projects `candidate_extractions.raw_output.languages[]` into
 * `candidate_languages` rows. Service layer, all I/O injected so unit
 * tests don't need Supabase.
 *
 * Contract:
 *   1. Loads the extraction row. Missing → throws (the worker should
 *      never queue a non-existent id).
 *   2. Idempotency guard: if any rows already exist for this extraction
 *      (`hasExistingLanguages`), returns `{ skipped: true, ... 0 }` —
 *      the worker can retry batches safely.
 *   3. Name is trimmed; entries whose name becomes empty are dropped.
 *   4. Dedup within the extraction by case-insensitive name. First
 *      occurrence's `level` wins; subsequent duplicates are discarded.
 *   5. Level: empty/whitespace-only strings normalize to `null`.
 *   6. Empty resulting list → no insert call.
 *
 * Re-extraction (new model/prompt_version → new extraction row →
 * different hash) creates a fresh `candidate_extractions` row and thus
 * a fresh idempotency scope — stale derivations are not cleaned up
 * here by design; that is a separate reconcile concern.
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

function normalizeLevel(level: string | null): string | null {
  if (level === null) return null;
  const trimmed = level.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export async function deriveLanguages(
  extractionId: string,
  deps: DeriveLanguagesDeps,
): Promise<DeriveLanguagesResult> {
  const extraction = await deps.loadExtraction(extractionId);
  if (extraction === null) {
    throw new Error(`deriveLanguages: extraction not found: ${extractionId}`);
  }

  if (await deps.hasExistingLanguages(extractionId)) {
    return { skipped: true, languagesInserted: 0 };
  }

  const seen = new Set<string>();
  const rows: LanguageInsertRow[] = [];
  for (const lang of extraction.raw_output.languages) {
    const name = lang.name.trim();
    if (name.length === 0) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({
      candidate_id: extraction.candidate_id,
      extraction_id: extractionId,
      name,
      level: normalizeLevel(lang.level),
    });
  }

  if (rows.length === 0) {
    return { skipped: false, languagesInserted: 0 };
  }

  const inserted = await deps.insertLanguages(rows);
  return { skipped: false, languagesInserted: inserted };
}
