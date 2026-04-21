/**
 * `preFilterByMustHave` — F4-008 sub-B (RED stub).
 *
 * Narrows the candidate pool to those who have at least one
 * `experience_skills` row per resolved must-have skill, *before*
 * loading full aggregates. Invariants per ADR-015:
 *   - Unresolved must-have (`skill_id = null`) does NOT filter.
 *   - No resolved must-have → full candidate pool.
 *   - Resolved must-have → AND-intersection of candidates per skill.
 *
 * All I/O is injected.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

export interface PreFilterByMustHaveDeps {
  fetchCandidatesWithAllSkills: (skillIds: string[], tenantId: string | null) => Promise<string[]>;
  fetchAllCandidateIds: (tenantId: string | null) => Promise<string[]>;
}

export async function preFilterByMustHave(
  _jobQuery: ResolvedDecomposition,
  _tenantId: string | null,
  _deps: PreFilterByMustHaveDeps,
): Promise<string[]> {
  throw new Error('preFilterByMustHave: not implemented (F4-008 sub-B RED)');
}
