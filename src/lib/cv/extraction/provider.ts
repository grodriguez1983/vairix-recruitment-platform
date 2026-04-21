/**
 * `ExtractionProvider` interface (ADR-012 §3).
 *
 * Mirror of `EmbeddingProvider` from ADR-005: a thin seam that the
 * worker depends on, with concrete implementations per backend
 * (OpenAI LLM, deterministic stub, future linkedin parser).
 *
 *   - `model` identifies the backend (e.g. `'gpt-4o-mini'`,
 *     `'stub-v1'`). Changing it invalidates every `content_hash`.
 *   - `promptVersion` is the constant from the prompt file (e.g.
 *     `EXTRACTION_PROMPT_V1 = '2026-04-v1'`). Bumping it also
 *     invalidates the hash; that's the point (ADR-012 §5).
 *   - `extract(parsedText)` is the only operation. Must NEVER throw
 *     silently — errors propagate to the worker so they can land in
 *     `sync_errors`.
 */
import type { ExtractionResult } from './types';

export interface ExtractionProvider {
  readonly model: string;
  readonly promptVersion: string;
  extract(parsedText: string): Promise<ExtractionResult>;
}
