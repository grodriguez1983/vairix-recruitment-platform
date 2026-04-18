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
  /**
   * Optional whitelist of candidate_ids. When set, the RPC restricts
   * similarity to this set — used by hybrid search (UC-01) to rerank
   * a pre-filtered structured result.
   */
  candidateIds?: readonly string[];
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

const DEFAULT_LIMIT = 20;

function isSourceType(v: string): v is EmbeddingSourceType {
  return v === 'profile' || v === 'notes' || v === 'cv' || v === 'evaluation';
}

export async function semanticSearchCandidates(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: SemanticSearchOptions,
): Promise<SemanticSearchHit[]> {
  const query = options.query.trim();
  if (query.length === 0) return [];

  const [vector] = await provider.embed([query]);
  if (!vector) throw new Error('semantic search: provider returned no vector');
  if (vector.length !== provider.dim) {
    throw new Error(
      `semantic search: provider returned vector of length ${vector.length}, expected ${provider.dim}`,
    );
  }

  const { data, error } = await db.rpc('semantic_search_embeddings', {
    query_embedding: vector,
    max_results: options.limit ?? DEFAULT_LIMIT,
    source_type_filter:
      options.sourceTypes && options.sourceTypes.length > 0 ? [...options.sourceTypes] : undefined,
    candidate_id_filter:
      options.candidateIds && options.candidateIds.length > 0
        ? [...options.candidateIds]
        : undefined,
  });
  if (error) throw new Error(`semantic search RPC failed: ${error.message}`);

  const hits: SemanticSearchHit[] = [];
  for (const row of data ?? []) {
    const sourceType = row.source_type;
    if (!isSourceType(sourceType)) continue;
    hits.push({
      candidateId: row.candidate_id,
      sourceType,
      score: Number(row.score),
    });
  }
  return hits;
}

export function dedupeByCandidate(
  hits: readonly SemanticSearchHit[],
): SemanticSearchCandidateMatch[] {
  const byId = new Map<string, SemanticSearchCandidateMatch>();
  for (const h of hits) {
    const existing = byId.get(h.candidateId);
    if (!existing) {
      byId.set(h.candidateId, {
        candidateId: h.candidateId,
        bestScore: h.score,
        matchedSources: [h.sourceType],
      });
      continue;
    }
    if (h.score > existing.bestScore) existing.bestScore = h.score;
    if (!existing.matchedSources.includes(h.sourceType)) {
      existing.matchedSources.push(h.sourceType);
    }
  }
  return Array.from(byId.values()).sort((a, b) => b.bestScore - a.bestScore);
}
