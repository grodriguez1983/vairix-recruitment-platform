/**
 * `resolveRequirements` — pure function that applies the skills
 * catalog (ADR-013) to a `DecompositionResult` and emits the
 * resolved shape plus a list of unresolved `skill_raw` values
 * (ADR-014 §5).
 *
 * Pure so that the re-resolve flow (ADR-014 §5: catalog changed,
 * re-resolve cached decomposed_json) can run without re-calling the
 * LLM.
 *
 * Output shape (`resolved`):
 *   - same structure as input
 *   - each requirement gets `skill_id` (catalog id or null) and
 *     `resolved_at` (ISO timestamp when resolved, null otherwise)
 *
 * `unresolved_skills` is a deduped list of `skill_raw` (verbatim —
 * the UI shows the exact string the recruiter typed). Order follows
 * first-occurrence in the input so the output is deterministic.
 */
import { resolveSkill, type CatalogSnapshot } from '../../skills/resolver';

import type { DecompositionResult, JobQueryLanguage, Requirement, Seniority } from './types';

export interface ResolvedRequirement extends Requirement {
  skill_id: string | null;
  resolved_at: string | null;
}

export interface ResolvedDecomposition {
  requirements: ResolvedRequirement[];
  seniority: Seniority;
  languages: JobQueryLanguage[];
  notes: string | null;
}

export interface ResolveRequirementsResult {
  resolved: ResolvedDecomposition;
  unresolved_skills: string[];
}

export interface ResolveRequirementsOptions {
  now?: () => Date;
}

export function resolveRequirements(
  decomposition: DecompositionResult,
  catalog: CatalogSnapshot,
  options: ResolveRequirementsOptions = {},
): ResolveRequirementsResult {
  const now = options.now ?? (() => new Date());
  const resolvedAt = now().toISOString();

  const unresolvedSet = new Set<string>();
  const unresolvedOrder: string[] = [];

  const requirements: ResolvedRequirement[] = decomposition.requirements.map((r) => {
    const hit = resolveSkill(r.skill_raw, catalog);
    if (hit !== null) {
      return { ...r, skill_id: hit.skill_id, resolved_at: resolvedAt };
    }
    if (!unresolvedSet.has(r.skill_raw)) {
      unresolvedSet.add(r.skill_raw);
      unresolvedOrder.push(r.skill_raw);
    }
    return { ...r, skill_id: null, resolved_at: null };
  });

  return {
    resolved: {
      requirements,
      seniority: decomposition.seniority,
      languages: decomposition.languages,
      notes: decomposition.notes,
    },
    unresolved_skills: unresolvedOrder,
  };
}
