/**
 * `loadCandidateAggregates(candidateIds, deps)` — F4-008 sub-A.
 *
 * Loader between the DB and the `DeterministicRanker`. Fans out raw
 * rows (experiences + experience_skills + languages), runs
 * `mergeVariants` per candidate to collapse cv_primary +
 * linkedin_export pairs, and assembles `CandidateAggregate[]`.
 *
 * All I/O is injected so the unit suite doesn't need Supabase. The
 * integration test (sub-D) exercises the real SQL path under RLS.
 */
import type { CandidateAggregate, ExperienceKind, ExperienceSkill, SourceVariant } from './types';

export interface CandidateExperienceRow {
  candidate_id: string;
  id: string;
  source_variant: SourceVariant;
  kind: ExperienceKind;
  company: string | null;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
  skills: ExperienceSkill[];
}

export interface CandidateLanguageRow {
  candidate_id: string;
  name: string;
  level: string | null;
}

export interface LoadCandidateAggregatesDeps {
  loadExperiences: (candidateIds: string[]) => Promise<CandidateExperienceRow[]>;
  loadLanguages: (candidateIds: string[]) => Promise<CandidateLanguageRow[]>;
}

export async function loadCandidateAggregates(
  _candidateIds: string[],
  _deps: LoadCandidateAggregatesDeps,
): Promise<CandidateAggregate[]> {
  throw new Error('loadCandidateAggregates: not implemented (F4-008 sub-A RED)');
}
