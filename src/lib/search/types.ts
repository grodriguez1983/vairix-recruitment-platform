/**
 * Structured candidate search types.
 *
 * F1-010a implements only the structured (SQL filter) part of UC-01.
 * Semantic search via embeddings lands later (needs F1-007 worker).
 *
 * Filter semantics:
 *   - `q`: free-text substring match over candidate name, email, and
 *     pitch. ILIKE — case-insensitive. Empty/whitespace `q` with no
 *     other filter set returns zero results (spec UC-01 acceptance
 *     `test_search_empty_query_returns_empty`).
 *   - `status`: filters via the applications table. A candidate
 *     matches if they have AT LEAST ONE application with this status.
 *   - `rejected_after` / `rejected_before`: ISO timestamps, inclusive
 *     lower / exclusive upper bound on `applications.rejected_at`.
 *   - `job_id`: candidates who applied to this job.
 *
 * Paging: 1-indexed `page`, `pageSize` clamped by the route layer.
 * The search function trusts its input — the route is the boundary.
 */

export interface SearchFilters {
  q: string | null;
  status: 'active' | 'rejected' | 'hired' | 'withdrawn' | null;
  rejectedAfter: string | null;
  rejectedBefore: string | null;
  jobId: string | null;
  /**
   * When `true`, restrict results to candidates with a VAIRIX CV
   * sheet associated — either the Google Sheets URL stored by
   * Teamtailor under custom interview question `Información para CV`
   * (question_tt_id=24016) OR an uploaded xlsx file
   * (files.kind='vairix_cv_sheet'). `false` / `null` → ignored.
   */
  hasVairixCvSheet: boolean | null;
  page: number;
  pageSize: number;
}

export interface SearchResultCandidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  pitch: string | null;
  linkedinUrl: string | null;
}

export interface SearchResultPage {
  results: SearchResultCandidate[];
  page: number;
  pageSize: number;
  total: number;
}
