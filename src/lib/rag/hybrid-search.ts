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
  semanticSearchCandidates,
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

function hasStructuredFilter(filters: HybridSearchOptions['filters']): boolean {
  return (
    filters.status !== null ||
    filters.rejectedAfter !== null ||
    filters.rejectedBefore !== null ||
    filters.jobId !== null
  );
}

async function candidateIdsMatchingFilters(
  db: SupabaseClient,
  filters: HybridSearchOptions['filters'],
): Promise<string[]> {
  let query = db.from('applications').select('candidate_id');
  if (filters.status !== null) query = query.eq('status', filters.status);
  if (filters.rejectedAfter !== null) query = query.gte('rejected_at', filters.rejectedAfter);
  if (filters.rejectedBefore !== null) query = query.lt('rejected_at', filters.rejectedBefore);
  if (filters.jobId !== null) query = query.eq('job_id', filters.jobId);

  const { data, error } = await query;
  if (error) throw new Error(`hybrid search: applications filter failed: ${error.message}`);

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = (row as { candidate_id: string | null }).candidate_id;
    if (id !== null) ids.add(id);
  }
  return Array.from(ids);
}

export async function hybridSearchCandidates(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: HybridSearchOptions,
): Promise<HybridSearchResult> {
  const query = options.query?.trim() ?? '';
  const hasQuery = query.length > 0;
  const hasFilter = hasStructuredFilter(options.filters);

  // Caller must supply at least one signal. A totally empty input is
  // ambiguous (return all? return none?) so we treat it as empty to
  // match UC-01 acceptance `test_search_empty_query_returns_empty`.
  if (!hasQuery && !hasFilter) {
    return { matches: [], candidateIds: [], mode: 'empty' };
  }

  // Step 1: resolve structured filters (or skip if none).
  const candidateIds = hasFilter ? await candidateIdsMatchingFilters(db, options.filters) : [];

  // Step 2a: filter set is empty ⇒ no ranking possible.
  if (hasFilter && candidateIds.length === 0) {
    return { matches: [], candidateIds: [], mode: 'empty' };
  }

  // Step 2b: no query ⇒ structured-only, return ids unranked.
  if (!hasQuery) {
    return { matches: [], candidateIds, mode: 'structured' };
  }

  // Step 3: semantic rerank, restricted to the filter set if one exists.
  const hits = await semanticSearchCandidates(db, provider, {
    query,
    limit: options.limit,
    sourceTypes: options.sourceTypes,
    candidateIds: hasFilter ? candidateIds : undefined,
  });

  return {
    matches: dedupeByCandidate(hits),
    candidateIds,
    mode: 'hybrid',
  };
}
