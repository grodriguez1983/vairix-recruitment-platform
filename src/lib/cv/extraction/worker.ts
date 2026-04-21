/**
 * CV extraction worker (ADR-012 §6).
 *
 * Consumes `files` rows that were parsed to text (F1-008 /
 * parse-worker) and have no `candidate_extractions` for the current
 * `(model, prompt_version)`. For each row:
 *
 *   1. Classify variant (`variant-classifier`, ADR-012 §1).
 *   2. Compute `content_hash` = SHA256(parsed_text || NUL || model
 *      || NUL || prompt_version).
 *   3. If a row with that hash already exists — skip (no API call,
 *      no insert). This saves tokens when two files share text.
 *   4. Otherwise call `provider.extract(parsed_text)` and insert
 *      into `candidate_extractions`.
 *
 * Per-row errors are logged to `sync_errors` and the batch continues
 * (ADR-004 pattern). Service-role access is the worker caller's
 * responsibility — wiring lives in `src/scripts/extract-cvs.ts`.
 *
 * All I/O is injected via `CvExtractionWorkerDeps` so the worker is
 * unit-testable without Supabase or OpenAI.
 *
 * NOTE on backends: ADR-012 §2 describes a deterministic LinkedIn
 * parser alongside the LLM extractor. The parser is a Fase 2+ item
 * (see roadmap F4-004 DoD). In this phase both variants flow
 * through the injected `provider`; `source_variant` still reflects
 * the classification so downstream weighting (ADR-015) is correct.
 */
import { classifyVariant } from '../variant-classifier';

import { extractionContentHash } from './hash';
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
  deps: CvExtractionWorkerDeps,
  options: CvExtractionRunOptions = {},
): Promise<CvExtractionRunResult> {
  const batchSize = options.batchSize ?? 50;
  const pending = await deps.listPending(batchSize);

  let extracted = 0;
  let skipped = 0;
  let errored = 0;

  for (const row of pending) {
    const variant = classifyVariant(row.parsed_text).variant;
    const hash = extractionContentHash(
      row.parsed_text,
      deps.provider.model,
      deps.provider.promptVersion,
    );

    if (await deps.extractionExistsByHash(hash)) {
      skipped += 1;
      continue;
    }

    try {
      const rawOutput = await deps.provider.extract(row.parsed_text);
      await deps.insertExtraction({
        candidate_id: row.candidate_id,
        file_id: row.file_id,
        source_variant: variant,
        model: deps.provider.model,
        prompt_version: deps.provider.promptVersion,
        content_hash: hash,
        raw_output: rawOutput,
      });
      extracted += 1;
    } catch (e) {
      await deps.logRowError({
        entity: 'cv_extraction',
        entity_id: row.file_id,
        message: e instanceof Error ? e.message : String(e),
      });
      errored += 1;
    }
  }

  return { processed: pending.length, extracted, skipped, errored };
}
