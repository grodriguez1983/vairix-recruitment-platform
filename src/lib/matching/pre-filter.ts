/**
 * `preFilterByMustHave` — F4-008 sub-B + F4-008 ter.
 *
 * Narrows the candidate pool to those who have at least one
 * `experience_skills` row per resolved must-have skill, *before*
 * loading full aggregates. Also emits an `excluded` pool of
 * candidates with partial or zero must-have coverage so the
 * post-rank rescue bucket (ADR-016 §1) can FTS-check
 * `files.parsed_text` for must-haves the extraction LLM missed.
 *
 * Invariants per ADR-015:
 *   - Unresolved must-have (`skill_id = null`) does NOT filter.
 *   - No resolved must-have → full candidate pool as `included`,
 *     `excluded` is empty (nothing to rescue).
 *   - Resolved must-have → AND-intersection of candidates per skill
 *     for `included`; the complement of the full candidate pool
 *     becomes `excluded` with per-candidate
 *     `missing_must_have_skill_ids`.
 *
 * All I/O is injected.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

export interface PreFilterByMustHaveDeps {
  fetchAllCandidateIds: (tenantId: string | null) => Promise<string[]>;
  /**
   * For each candidate with at least one `experience_skills` row
   * among `skillIds`, return the subset of `skillIds` they cover.
   * Candidates with zero hits MAY be omitted — the pure function
   * infers them as "covered_skill_ids: []" from the `fetchAllCandidateIds`
   * complement.
   */
  fetchCandidateMustHaveCoverage: (
    skillIds: string[],
    tenantId: string | null,
  ) => Promise<Array<{ candidate_id: string; covered_skill_ids: string[] }>>;
}

export interface PreFilterExcludedCandidate {
  candidate_id: string;
  missing_must_have_skill_ids: string[];
}

export interface PreFilterByMustHaveResult {
  included: string[];
  excluded: PreFilterExcludedCandidate[];
}

export async function preFilterByMustHave(
  _jobQuery: ResolvedDecomposition,
  _tenantId: string | null,
  _deps: PreFilterByMustHaveDeps,
): Promise<PreFilterByMustHaveResult> {
  // [RED] stub — GREEN commit fills this in.
  return { included: [], excluded: [] };
}
