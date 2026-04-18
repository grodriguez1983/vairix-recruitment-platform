/**
 * Semantic candidate search (F3-002, ADR-005 §Consumo).
 *
 * Shape of the pipeline:
 *   1. Embed the query string with the same provider used to build
 *      the corpus (hash compatibility is not an issue here — we
 *      only need the vector; it never hits the content_hash table).
 *   2. Call the `semantic_search_embeddings` RPC with the vector.
 *      RLS applies through `security invoker`, so a non-authenticated
 *      caller sees nothing.
 *   3. Optionally deduplicate by `candidate_id` keeping the best
 *      score across source types — most UIs want one row per
 *      candidate, not one per embedded source.
 *
 * This module is framework-agnostic (no Next.js imports): API routes
 * and scripts compose on top of it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from '../embeddings/provider';

export type EmbeddingSourceType = 'profile' | 'notes' | 'cv' | 'evaluation';

export interface SemanticSearchOptions {
  query: string;
  limit?: number;
  sourceTypes?: readonly EmbeddingSourceType[];
}

export interface SemanticSearchHit {
  candidateId: string;
  sourceType: EmbeddingSourceType;
  score: number;
}

export interface SemanticSearchCandidateMatch {
  candidateId: string;
  bestScore: number;
  matchedSources: EmbeddingSourceType[];
}

// RED stub — real implementation lands in the GREEN commit.
export async function semanticSearchCandidates(
  _db: SupabaseClient,
  _provider: EmbeddingProvider,
  _options: SemanticSearchOptions,
): Promise<SemanticSearchHit[]> {
  throw new Error('not implemented');
}

// RED stub — real implementation lands in the GREEN commit.
export function dedupeByCandidate(
  _hits: readonly SemanticSearchHit[],
): SemanticSearchCandidateMatch[] {
  throw new Error('not implemented');
}
