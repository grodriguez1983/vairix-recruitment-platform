/**
 * CV-source embeddings worker (ADR-005, F3-001).
 *
 * One embedding per candidate (`source_type='cv'`, `source_id=null`)
 * built from the most recent parsed CV in `files.parsed_text`. Older
 * CVs are ignored; soft-deleted files are ignored. Regeneration is
 * driven by `content_hash` (salted with provider.model).
 *
 * Service-role caller required (embeddings are cross-tenant infra).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from './provider';

export interface RunCvEmbeddingsOptions {
  candidateIds?: string[];
  batchSize?: number;
}

export interface CvEmbeddingsResult {
  processed: number;
  skipped: number;
  regenerated: number;
  reused: number;
}

export async function runCvEmbeddings(
  _db: SupabaseClient,
  _provider: EmbeddingProvider,
  _options: RunCvEmbeddingsOptions = {},
): Promise<CvEmbeddingsResult> {
  throw new Error('runCvEmbeddings: not implemented');
}
