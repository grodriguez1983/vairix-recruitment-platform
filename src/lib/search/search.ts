/**
 * Structured candidate search — SKELETON for the RED phase of F1-010a.
 *
 * See tests/integration/search/structured-search.test.ts for the
 * behavior contract. This file intentionally throws so the tests
 * fail; the GREEN commit fills in the real query.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SearchFilters, SearchResultPage } from './types';

export function searchCandidates(
  _supabase: SupabaseClient,
  _filters: SearchFilters,
): Promise<SearchResultPage> {
  throw new Error('searchCandidates: not implemented (F1-010a GREEN pending)');
}
