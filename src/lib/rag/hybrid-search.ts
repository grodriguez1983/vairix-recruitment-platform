/**
 * Hybrid candidate search — structured filters + semantic rerank
 * (F3-003, UC-01).
 *
 * Flow:
 *   1. Resolve the SearchFilters to a set of candidate_ids by
 *      querying the `applications` table (status, rejected_at,
 *      job_id).
 *   2. If the filter set is empty → return no matches (an empty
 *      filter intersection dominates: no need to embed or call the
 *      RPC).
 *   3. If the user provided no `query` string → return the filter
 *      set as unranked matches (score = null semantics: caller
 *      decides ordering).
 *   4. Otherwise, call `semantic_search_embeddings` with the
 *      candidate_id_filter restricted to the filter set, then
 *      dedupe by candidate.
 *
 * Why push the id filter into the RPC (not client-side): the ivfflat
 * scan can prune early when the candidate set is small, and we only
 * pay the network cost of the rows we'll actually keep.
 *
 * Trust boundary: this module trusts its inputs. Route handlers own
 * auth + Zod validation + the RLS-scoped Supabase client.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from '../embeddings/provider';
import type { SearchFilters } from '../search/types';

import {
  dedupeByCandidate,
  type EmbeddingSourceType,
  type SemanticSearchCandidateMatch,
} from './semantic-search';

export type HybridSearchMode = 'hybrid' | 'structured' | 'empty';

export interface HybridSearchOptions {
  query: string | null;
  filters: Pick<SearchFilters, 'status' | 'rejectedAfter' | 'rejectedBefore' | 'jobId'>;
  limit?: number;
  sourceTypes?: readonly EmbeddingSourceType[];
}

export interface HybridSearchResult {
  matches: SemanticSearchCandidateMatch[];
  candidateIds: string[];
  mode: HybridSearchMode;
}

// RED stub — real implementation lands in the GREEN commit.
export async function hybridSearchCandidates(
  _db: SupabaseClient,
  _provider: EmbeddingProvider,
  _options: HybridSearchOptions,
): Promise<HybridSearchResult> {
  // Exercises the imports so typecheck treats them as used; all paths throw.
  void dedupeByCandidate;
  throw new Error('not implemented');
}
