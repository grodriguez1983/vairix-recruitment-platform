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
import { mergeVariants } from './variant-merger';
import type {
  CandidateAggregate,
  ExperienceInput,
  ExperienceKind,
  ExperienceSkill,
  SourceVariant,
} from './types';

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

function toExperienceInput(row: CandidateExperienceRow): ExperienceInput {
  return {
    id: row.id,
    source_variant: row.source_variant,
    kind: row.kind,
    company: row.company,
    title: row.title,
    start_date: row.start_date,
    end_date: row.end_date,
    description: row.description,
    skills: row.skills,
  };
}

export async function loadCandidateAggregates(
  candidateIds: string[],
  deps: LoadCandidateAggregatesDeps,
): Promise<CandidateAggregate[]> {
  if (candidateIds.length === 0) return [];

  const [experienceRows, languageRows] = await Promise.all([
    deps.loadExperiences(candidateIds),
    deps.loadLanguages(candidateIds),
  ]);

  const expByCandidate = new Map<string, ExperienceInput[]>();
  for (const row of experienceRows) {
    const list = expByCandidate.get(row.candidate_id) ?? [];
    list.push(toExperienceInput(row));
    expByCandidate.set(row.candidate_id, list);
  }

  const langByCandidate = new Map<string, Array<{ name: string; level: string | null }>>();
  for (const row of languageRows) {
    const list = langByCandidate.get(row.candidate_id) ?? [];
    list.push({ name: row.name, level: row.level });
    langByCandidate.set(row.candidate_id, list);
  }

  return candidateIds.map((candidate_id) => {
    const exps = expByCandidate.get(candidate_id) ?? [];
    const { experiences } = mergeVariants(exps);
    return {
      candidate_id,
      merged_experiences: experiences,
      languages: langByCandidate.get(candidate_id) ?? [],
    };
  });
}
