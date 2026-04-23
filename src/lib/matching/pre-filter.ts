/**
 * `preFilterByMustHave` — F4-008 sub-B + F4-008 ter (+ ADR-021).
 *
 * Narrows the candidate pool to those who cover every must-have
 * group of the decomposition, *before* loading full aggregates.
 * Also emits an `excluded` pool of candidates with partial or zero
 * coverage so the post-rank rescue bucket (ADR-016 §1) can FTS-check
 * `files.parsed_text` for must-haves the extraction LLM missed.
 *
 * Invariants (ADR-015 + ADR-021):
 *   - Unresolved must-have (`skill_id = null`) does NOT filter.
 *   - A must-have group is defined by `alternative_group_id`:
 *       null → each requirement is its own singleton group.
 *       non-null → all requirements sharing the id are the same
 *       group (OR within, AND between).
 *   - A group is "active" when it has ≥1 resolved alternative;
 *     otherwise it drops out of the filter entirely.
 *   - No active groups → full candidate pool as `included`,
 *     `excluded` is empty (nothing to rescue).
 *   - Active groups → candidate is `included` iff they cover ≥1
 *     resolved alternative of *every* active group. The complement
 *     becomes `excluded`; `missing_must_have_skill_ids` is the flat
 *     union of resolved alternatives across the groups they failed
 *     to cover — the rescue layer FTS-checks each alternative.
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

interface MustHaveGroup {
  /** Resolved alternative skill_ids for this group. Always non-empty
   *  because groups with zero resolved alternatives are dropped. */
  skill_ids: string[];
}

/** Build the active must-have groups from the decomposition. Groups
 *  with `alternative_group_id = null` are treated as singletons: each
 *  such requirement is its own unique group. Shared non-null ids
 *  collapse into one group. A group is emitted only when it has at
 *  least one resolved alternative; a fully-unresolved group drops
 *  out (ADR-015 — unresolved does not filter). */
function buildMustHaveGroups(jobQuery: ResolvedDecomposition): MustHaveGroup[] {
  const namedGroups = new Map<string, string[]>();
  const singletons: MustHaveGroup[] = [];

  for (const req of jobQuery.requirements) {
    if (!req.must_have) continue;
    if (req.skill_id === null) continue;
    const groupId = req.alternative_group_id;
    if (groupId === null) {
      singletons.push({ skill_ids: [req.skill_id] });
    } else {
      const existing = namedGroups.get(groupId);
      if (existing) existing.push(req.skill_id);
      else namedGroups.set(groupId, [req.skill_id]);
    }
  }

  const groups: MustHaveGroup[] = [...singletons];
  for (const skill_ids of namedGroups.values()) groups.push({ skill_ids });
  return groups;
}

export async function preFilterByMustHave(
  jobQuery: ResolvedDecomposition,
  tenantId: string | null,
  deps: PreFilterByMustHaveDeps,
): Promise<PreFilterByMustHaveResult> {
  const groups = buildMustHaveGroups(jobQuery);

  if (groups.length === 0) {
    const included = await deps.fetchAllCandidateIds(tenantId);
    return { included, excluded: [] };
  }

  const allResolvedSkillIds: string[] = [];
  const seen = new Set<string>();
  for (const g of groups) {
    for (const s of g.skill_ids) {
      if (!seen.has(s)) {
        seen.add(s);
        allResolvedSkillIds.push(s);
      }
    }
  }

  const [allIds, coverageRows] = await Promise.all([
    deps.fetchAllCandidateIds(tenantId),
    deps.fetchCandidateMustHaveCoverage(allResolvedSkillIds, tenantId),
  ]);

  const coverageByCandidate = new Map<string, Set<string>>();
  for (const row of coverageRows) {
    const covered = new Set<string>();
    for (const skillId of row.covered_skill_ids) {
      if (seen.has(skillId)) covered.add(skillId);
    }
    coverageByCandidate.set(row.candidate_id, covered);
  }

  const included: string[] = [];
  const excluded: PreFilterExcludedCandidate[] = [];
  for (const candidateId of allIds) {
    const covered = coverageByCandidate.get(candidateId) ?? new Set<string>();
    const missingGroups: MustHaveGroup[] = [];
    for (const group of groups) {
      const covers = group.skill_ids.some((s) => covered.has(s));
      if (!covers) missingGroups.push(group);
    }
    if (missingGroups.length === 0) {
      included.push(candidateId);
      continue;
    }
    // Flat union of every resolved alternative in the failed groups.
    // Dedup to keep the list stable for the rescue layer.
    const missingSet = new Set<string>();
    for (const g of missingGroups) for (const s of g.skill_ids) missingSet.add(s);
    excluded.push({
      candidate_id: candidateId,
      missing_must_have_skill_ids: [...missingSet],
    });
  }

  return { included, excluded };
}
