/**
 * `preFilterByMustHave` — F4-008 sub-B.
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
  jobQuery: ResolvedDecomposition,
  tenantId: string | null,
  deps: PreFilterByMustHaveDeps,
): Promise<string[]> {
  const resolvedMustHaveSkillIds: string[] = [];
  for (const req of jobQuery.requirements) {
    if (req.must_have && req.skill_id !== null) {
      resolvedMustHaveSkillIds.push(req.skill_id);
    }
  }

  if (resolvedMustHaveSkillIds.length === 0) {
    return deps.fetchAllCandidateIds(tenantId);
  }

  return deps.fetchCandidatesWithAllSkills(resolvedMustHaveSkillIds, tenantId);
}
