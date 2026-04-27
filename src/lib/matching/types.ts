/**
 * Shared types for the deterministic matcher (ADR-015).
 *
 * These types are the ranker's view of the world: DB-agnostic,
 * post-derivation, post-resolution. Callers convert DB rows (
 * `candidate_experiences` + `experience_skills`) into
 * `ExperienceInput[]` before handing them to `mergeVariants()`.
 */
import type {
  ResolvedDecomposition,
  ResolvedRequirement,
} from '../rag/decomposition/resolve-requirements';

export type ExperienceKind = 'work' | 'side_project' | 'education';
export type SourceVariant = 'linkedin_export' | 'cv_primary';

/**
 * Flat shape of a single `candidate_experiences` row with its attached
 * `experience_skills`. `skills` is the post-derivation list — each
 * entry carries `skill_id` (null when the skill did not resolve to the
 * catalog) + the verbatim `skill_raw`.
 */
export interface ExperienceInput {
  id: string;
  source_variant: SourceVariant;
  kind: ExperienceKind;
  company: string | null;
  title: string | null;
  /** ISO date `YYYY-MM-DD` or null (unknown). */
  start_date: string | null;
  /** ISO date `YYYY-MM-DD` or null (present / unknown). */
  end_date: string | null;
  description: string | null;
  skills: ExperienceSkill[];
}

export interface ExperienceSkill {
  skill_id: string | null;
  skill_raw: string;
}

/**
 * Output of `mergeVariants()`. When a pair of experiences (one
 * cv_primary + one linkedin_export) is collapsed into a single
 * canonical row, `merged_from_ids` lists the original IDs — this
 * feeds `candidate_experiences.merged_from_ids` (already in the
 * schema) and the diagnostics channel of the ranker.
 */
export interface MergedExperience {
  id: string;
  source_variant: SourceVariant;
  kind: ExperienceKind;
  company: string | null;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
  skills: ExperienceSkill[];
  merged_from_ids: string[];
}

/**
 * Diagnostics emitted alongside the merged experiences. The ranker
 * propagates these to `match_runs.diagnostics` (ADR-015 §Notas de
 * implementación).
 */
export interface MergeDiagnostic {
  kind: 'merged' | 'kept_distinct_below_threshold';
  cv_primary_id: string;
  linkedin_id: string;
  overlap_ratio: number;
  company_match: boolean;
  title_match: boolean;
}

export interface MergeResult {
  experiences: MergedExperience[];
  diagnostics: MergeDiagnostic[];
}

// ────────────────────────────────────────────────────────────────
// Scoring types (filled in by score-aggregator + ranker sub-blocks).
// ────────────────────────────────────────────────────────────────

export interface CandidateAggregate {
  candidate_id: string;
  merged_experiences: MergedExperience[];
  languages: Array<{ name: string; level: string | null }>;
}

export type MatchStatus = 'match' | 'partial' | 'missing';
export type MustHaveGate = 'passed' | 'failed';
export type SeniorityMatch = 'match' | 'below' | 'above' | 'unknown';

export interface RequirementBreakdown {
  requirement: ResolvedRequirement;
  /**
   * Years that fed `years_ratio`. Equals `effective_years` (post-decay)
   * since ADR-026; before that it was the raw sweep-line output of
   * `yearsForSkill`. Backward compatible at the field name level —
   * readers see "what the ratio used", which is the only thing they
   * could meaningfully use anyway.
   */
  candidate_years: number;
  /**
   * ADR-026: pre-decay sweep-line years (work + side_project weighted
   * per ADR-020). Useful for explaining "the candidate has 5 raw
   * years, but the last one was 15y ago, so the effective is 0.36".
   */
  raw_years: number;
  /**
   * ADR-026: ISO date `YYYY-MM-DD` of the latest `end_date ?? asOf`
   * across work + side_project experiences mentioning the resolved
   * skill. `null` when no contributing experience exists.
   */
  last_used: string | null;
  /**
   * ADR-026: multiplicative decay applied to `raw_years` to obtain
   * `candidate_years`. Range `(0, 1]`. `1` means "no penalty"
   * (ongoing or no experience).
   */
  decay_factor: number;
  years_ratio: number;
  contribution: number;
  status: MatchStatus;
  evidence: Array<{
    experience_id: string;
    company: string | null;
    date_range: string;
  }>;
}

export interface CandidateScore {
  candidate_id: string;
  total_score: number;
  must_have_gate: MustHaveGate;
  breakdown: RequirementBreakdown[];
  language_match: { required: number; matched: number };
  seniority_match: SeniorityMatch;
}

export interface RankResult {
  results: CandidateScore[];
  diagnostics: Array<{ candidate_id: string; warning: string }>;
}

export interface RankerInput {
  jobQuery: ResolvedDecomposition;
  candidates: CandidateAggregate[];
  catalogSnapshotAt: Date;
}

export interface Ranker {
  rank(input: RankerInput): Promise<RankResult>;
}
