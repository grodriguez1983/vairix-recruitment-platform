/**
 * `DecompositionProvider` interface (ADR-014 §3).
 *
 * Mirror of `ExtractionProvider` (ADR-012 §3): a thin seam that the
 * decompose service depends on, with concrete implementations per
 * backend (OpenAI LLM, deterministic stub).
 *
 *   - `model` identifies the backend (`'gpt-4o-mini'`, `'stub-v1'`).
 *     Changing it invalidates every `content_hash` in `job_queries`
 *     (ADR-014 §4).
 *   - `promptVersion` is the constant from the prompt file
 *     (`DECOMPOSITION_PROMPT_V1 = '2026-04-v2'`). Bumping it also
 *     invalidates the hash — that's the point.
 *   - `decompose(rawText)` is the only operation. Errors propagate
 *     up as `DecompositionError` codes (`provider_failure`,
 *     `schema_violation`) so the caller can log to `sync_errors`.
 */
import type { DecompositionResult } from './types';

export interface DecompositionProvider {
  readonly model: string;
  readonly promptVersion: string;
  decompose(rawText: string): Promise<DecompositionResult>;
}
