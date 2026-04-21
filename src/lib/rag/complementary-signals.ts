/**
 * Complementary matching signals (ADR-016 §1).
 *
 * Recall-fallback over `files.parsed_text` for candidates that fail
 * the deterministic must-have gate: if the extractor missed a skill
 * that clearly shows up in the parsed CV text, we surface it in a
 * dedicated bucket (`match_rescues`) with `requires_manual_review`
 * semantics.
 *
 * This module is pure: the FTS query is injected via `queryFts` so
 * unit tests run without Supabase. The tuning knobs (threshold,
 * snippet cap) are constants per ADR-016 §Notas de implementación.
 */

export const FTS_RESCUE_THRESHOLD = 0.1;
export const EVIDENCE_SNIPPET_LIMIT = 5;

export interface FtsRescueCandidate {
  candidate_id: string;
  /** Must-have slugs that the structured ranker could NOT satisfy. */
  missing_skill_slugs: string[];
}

export interface FtsHit {
  candidate_id: string;
  skill_slug: string;
  ts_rank: number;
  snippet: string;
}

export interface ComplementarySignalsDeps {
  /**
   * Runs `plainto_tsquery(skill_slug)` against `files.parsed_text`
   * for the given candidate × skill cross-product. Implementations
   * must scope visibility via RLS (user client) or bypass it
   * intentionally (service-role, documented).
   */
  queryFts: (params: {
    candidateIds: string[];
    skillSlugs: string[];
    maxPerPair?: number;
  }) => Promise<FtsHit[]>;
}

export interface RescueRow {
  candidate_id: string;
  missing_skills: string[];
  /** skill_slug → snippets ordered by ts_rank desc, then snippet asc. */
  fts_snippets: Record<string, string[]>;
  fts_max_rank: number;
}

interface GroupedHit {
  ts_rank: number;
  snippet: string;
}

export async function fetchFtsRescues(
  candidates: FtsRescueCandidate[],
  deps: ComplementarySignalsDeps,
  options: { threshold?: number } = {},
): Promise<RescueRow[]> {
  const threshold = options.threshold ?? FTS_RESCUE_THRESHOLD;

  const active = candidates.filter((c) => c.missing_skill_slugs.length > 0);
  if (active.length === 0) return [];

  const candidateIds = Array.from(new Set(active.map((c) => c.candidate_id)));
  const skillSlugs = Array.from(new Set(active.flatMap((c) => c.missing_skill_slugs)));
  // Allowed skills per candidate — used to discard cross-pollinated
  // hits the FTS backend might return for slugs that were not
  // missing for a given candidate (defensive: the queryFts impl may
  // return the full cartesian, we filter here).
  const allowedByCandidate = new Map<string, Set<string>>();
  for (const c of active) {
    allowedByCandidate.set(c.candidate_id, new Set(c.missing_skill_slugs));
  }

  const hits = await deps.queryFts({ candidateIds, skillSlugs });

  // Group surviving hits by candidate → skill.
  const byCandidate = new Map<string, Map<string, GroupedHit[]>>();
  for (const hit of hits) {
    if (!(hit.ts_rank > threshold)) continue;
    const allowed = allowedByCandidate.get(hit.candidate_id);
    if (allowed === undefined || !allowed.has(hit.skill_slug)) continue;

    const bySkill = byCandidate.get(hit.candidate_id) ?? new Map<string, GroupedHit[]>();
    const list = bySkill.get(hit.skill_slug) ?? [];
    list.push({ ts_rank: hit.ts_rank, snippet: hit.snippet });
    bySkill.set(hit.skill_slug, list);
    byCandidate.set(hit.candidate_id, bySkill);
  }

  // Shape rescue rows; deterministic ordering by candidate_id asc.
  const missingByCandidate = new Map<string, string[]>();
  for (const c of active) missingByCandidate.set(c.candidate_id, c.missing_skill_slugs);

  const rows: RescueRow[] = [];
  for (const candidateId of Array.from(byCandidate.keys()).sort()) {
    const bySkill = byCandidate.get(candidateId)!;
    const snippets: Record<string, string[]> = {};
    let maxRank = 0;
    for (const [skill, group] of bySkill) {
      const sorted = [...group].sort((a, b) => {
        if (b.ts_rank !== a.ts_rank) return b.ts_rank - a.ts_rank;
        return a.snippet.localeCompare(b.snippet);
      });
      snippets[skill] = sorted.map((g) => g.snippet);
      for (const g of group) if (g.ts_rank > maxRank) maxRank = g.ts_rank;
    }
    rows.push({
      candidate_id: candidateId,
      missing_skills: missingByCandidate.get(candidateId) ?? [],
      fts_snippets: snippets,
      fts_max_rank: maxRank,
    });
  }
  return rows;
}
