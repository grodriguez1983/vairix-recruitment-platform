/**
 * Structured candidate search.
 *
 * Strategy:
 *   1. If any application-level filter is set (status, rejected_*,
 *      job_id), query `applications` first to get the candidate IDs
 *      that match. This keeps RLS checks local to each table (RLS on
 *      applications already excludes soft-deleted apps for recruiters).
 *   2. If `q` is set, apply ILIKE over candidate name/email/pitch.
 *   3. Soft delete is enforced by RLS, not by this query.
 *   4. Return paged results with `total` via PostgREST's exact count.
 *
 * Trust boundary: this function trusts its input. Route handlers are
 * responsible for Zod validation and for passing an RLS-scoped client
 * (not the service role).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { SearchFilters, SearchResultCandidate, SearchResultPage } from './types';

const EMPTY_PAGE: SearchResultPage = {
  results: [],
  page: 1,
  pageSize: 20,
  total: 0,
};

function hasAnyFilter(filters: SearchFilters): boolean {
  return (
    filters.q !== null ||
    filters.status !== null ||
    filters.rejectedAfter !== null ||
    filters.rejectedBefore !== null ||
    filters.jobId !== null ||
    filters.hasVairixCvSheet === true
  );
}

function hasApplicationFilter(filters: SearchFilters): boolean {
  return (
    filters.status !== null ||
    filters.rejectedAfter !== null ||
    filters.rejectedBefore !== null ||
    filters.jobId !== null
  );
}

/**
 * Resolves "candidates with a VAIRIX CV sheet associated" to a list
 * of candidate ids. A candidate qualifies if EITHER:
 *
 *   - an `evaluation_answers` row exists with
 *     `question_tt_id='24016'` and `value_text` non-null (the TT
 *     custom field `"Información para CV"` carrying the Google
 *     Sheets URL), OR
 *   - a `files` row exists with `kind='vairix_cv_sheet'` and no
 *     soft-delete (the manually uploaded xlsx/csv).
 *
 * Both lookups go through the RLS-scoped client so recruiters never
 * see rows they aren't allowed to. Duplicates are deduped into a Set.
 */
async function candidateIdsWithVairixCvSheet(supabase: SupabaseClient): Promise<string[]> {
  const ids = new Set<string>();

  const { data: answers, error: ansErr } = await supabase
    .from('evaluation_answers')
    .select('evaluation_id, value_text, evaluations:evaluations(candidate_id)')
    .eq('question_tt_id', '24016')
    .not('value_text', 'is', null);
  if (ansErr) {
    throw new Error(`search: evaluation_answers lookup failed: ${ansErr.message}`);
  }
  for (const row of answers ?? []) {
    // `evaluations` is a to-one embed, but PostgREST types it as
    // either an object or array depending on the generated types;
    // narrow defensively.
    const ev = (row as unknown as { evaluations: unknown }).evaluations;
    const candidateId = Array.isArray(ev)
      ? ((ev[0] as { candidate_id?: string | null } | undefined)?.candidate_id ?? null)
      : ((ev as { candidate_id?: string | null } | null)?.candidate_id ?? null);
    if (candidateId) ids.add(candidateId);
  }

  const { data: files, error: filesErr } = await supabase
    .from('files')
    .select('candidate_id')
    .eq('kind', 'vairix_cv_sheet')
    .is('deleted_at', null);
  if (filesErr) {
    throw new Error(`search: files lookup failed: ${filesErr.message}`);
  }
  for (const row of files ?? []) {
    const id = (row as { candidate_id: string | null }).candidate_id;
    if (id) ids.add(id);
  }

  return Array.from(ids);
}

function escapeIlikePattern(value: string): string {
  // PostgREST `.or()` parser treats `,` and `)` as separators. We
  // strip them from user input to keep the query shape simple. Real
  // ILIKE metachars (% and _) are also stripped so users can't
  // accidentally match everything with a bare `%`.
  return value.replace(/[,)(%_\\]/g, ' ');
}

async function candidateIdsMatchingApplications(
  supabase: SupabaseClient,
  filters: SearchFilters,
): Promise<string[]> {
  let query = supabase.from('applications').select('candidate_id');
  if (filters.status !== null) query = query.eq('status', filters.status);
  if (filters.rejectedAfter !== null) query = query.gte('rejected_at', filters.rejectedAfter);
  if (filters.rejectedBefore !== null) query = query.lt('rejected_at', filters.rejectedBefore);
  if (filters.jobId !== null) query = query.eq('job_id', filters.jobId);

  const { data, error } = await query;
  if (error) throw new Error(`search: applications filter failed: ${error.message}`);

  const ids = new Set<string>();
  for (const row of data ?? []) {
    const id = (row as { candidate_id: string | null }).candidate_id;
    if (id !== null) ids.add(id);
  }
  return Array.from(ids);
}

export async function searchCandidates(
  supabase: SupabaseClient,
  filters: SearchFilters,
): Promise<SearchResultPage> {
  if (!hasAnyFilter(filters)) {
    return { ...EMPTY_PAGE, page: filters.page, pageSize: filters.pageSize };
  }

  // Resolve application-level filters to a set of candidate_ids. An
  // empty set means "zero candidates matched" — short-circuit.
  let restrictToIds: string[] | null = null;
  if (hasApplicationFilter(filters)) {
    restrictToIds = await candidateIdsMatchingApplications(supabase, filters);
    if (restrictToIds.length === 0) {
      return { results: [], page: filters.page, pageSize: filters.pageSize, total: 0 };
    }
  }

  // "Has VAIRIX CV sheet" intersects with the set above (AND
  // semantics across independent filters).
  if (filters.hasVairixCvSheet === true) {
    const sheetIds = await candidateIdsWithVairixCvSheet(supabase);
    if (sheetIds.length === 0) {
      return { results: [], page: filters.page, pageSize: filters.pageSize, total: 0 };
    }
    if (restrictToIds === null) {
      restrictToIds = sheetIds;
    } else {
      const sheetSet = new Set(sheetIds);
      restrictToIds = restrictToIds.filter((id) => sheetSet.has(id));
      if (restrictToIds.length === 0) {
        return { results: [], page: filters.page, pageSize: filters.pageSize, total: 0 };
      }
    }
  }

  const from = (filters.page - 1) * filters.pageSize;
  const to = from + filters.pageSize - 1;

  let query = supabase
    .from('candidates')
    .select('id, first_name, last_name, email, pitch, linkedin_url', { count: 'exact' })
    .order('updated_at', { ascending: false })
    .range(from, to);

  if (restrictToIds !== null) {
    query = query.in('id', restrictToIds);
  }

  if (filters.q !== null) {
    const pattern = `%${escapeIlikePattern(filters.q)}%`;
    query = query.or(
      [
        `first_name.ilike.${pattern}`,
        `last_name.ilike.${pattern}`,
        `email.ilike.${pattern}`,
        `pitch.ilike.${pattern}`,
      ].join(','),
    );
  }

  const { data, error, count } = await query;
  if (error) throw new Error(`search: candidates query failed: ${error.message}`);

  const results: SearchResultCandidate[] = (data ?? []).map((row) => {
    const r = row as {
      id: string;
      first_name: string | null;
      last_name: string | null;
      email: string | null;
      pitch: string | null;
      linkedin_url: string | null;
    };
    return {
      id: r.id,
      firstName: r.first_name,
      lastName: r.last_name,
      email: r.email,
      pitch: r.pitch,
      linkedinUrl: r.linkedin_url,
    };
  });

  return {
    results,
    page: filters.page,
    pageSize: filters.pageSize,
    total: count ?? results.length,
  };
}
