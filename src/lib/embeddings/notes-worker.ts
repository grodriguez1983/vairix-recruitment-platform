/**
 * Notes-source embeddings worker (ADR-005, F3-001).
 *
 * Mirror of the profile worker, but the source content is the
 * chronological concatenation of a candidate's notes bodies. One
 * embedding row per candidate (`source_type='notes'`, `source_id=null`),
 * not one per note — this keeps the retrieval surface compact and
 * matches ADR-005 §Fuentes a embeber.
 *
 * Regeneration is still driven by `content_hash`, which depends on
 * provider.model + the final concatenated string. Adding a note,
 * editing one, or soft-deleting one all change the string and
 * therefore the hash.
 *
 * Service-role caller required (embeddings are cross-tenant infra
 * per ADR-003 and the embeddings RLS migration).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from './provider';

export interface RunNotesEmbeddingsOptions {
  candidateIds?: string[];
  batchSize?: number;
}

export interface NotesEmbeddingsResult {
  processed: number;
  skipped: number;
  regenerated: number;
  reused: number;
}

// RED stub — real implementation lands in the GREEN commit.
export async function runNotesEmbeddings(
  _db: SupabaseClient,
  _provider: EmbeddingProvider,
  _options: RunNotesEmbeddingsOptions = {},
): Promise<NotesEmbeddingsResult> {
  throw new Error('not implemented');
}
