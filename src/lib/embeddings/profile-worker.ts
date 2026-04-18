/**
 * Profile-source embeddings worker (F3-001 slice 2).
 * Stub — [GREEN] fills it in.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from './provider';

export interface RunProfileEmbeddingsOptions {
  /** When set, restrict the run to these candidate ids (for tests). */
  candidateIds?: string[];
  /** Upper bound on rows processed in one run (default 500). */
  batchSize?: number;
}

export interface ProfileEmbeddingsResult {
  /** Candidates whose profile content was non-null (i.e. considered for embedding). */
  processed: number;
  /** Candidates skipped because buildProfileContent returned null. */
  skipped: number;
  /** Subset of `processed` that triggered a new provider call + upsert. */
  regenerated: number;
  /** Subset of `processed` where the existing hash matched and nothing was written. */
  reused: number;
}

export async function runProfileEmbeddings(
  _db: SupabaseClient,
  _provider: EmbeddingProvider,
  _options?: RunProfileEmbeddingsOptions,
): Promise<ProfileEmbeddingsResult> {
  throw new Error('not implemented');
}
