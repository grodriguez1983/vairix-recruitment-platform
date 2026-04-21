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

export async function fetchFtsRescues(
  _candidates: FtsRescueCandidate[],
  _deps: ComplementarySignalsDeps,
  _options: { threshold?: number } = {},
): Promise<RescueRow[]> {
  throw new Error('fetchFtsRescues: not implemented (RED)');
}
