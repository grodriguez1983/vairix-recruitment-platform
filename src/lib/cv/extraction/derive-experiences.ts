/**
 * `deriveExperiences(extractionId, deps)` — F4-005 sub-B.
 *
 * Service layer between the pure tuple builder
 * (`./derivation.deriveFromRawOutput`) and the DB. All I/O is
 * injected so the unit suite doesn't need Supabase; sub-C's
 * integration test exercises the real SQL path.
 */
import type { CatalogSnapshot } from '../../skills/resolver';

import type { ExtractionResult, SourceVariant } from './types';

export interface ExperienceInsertRow {
  temp_key: string;
  candidate_id: string;
  extraction_id: string;
  source_variant: SourceVariant;
  kind: 'work' | 'side_project' | 'education';
  company: string | null;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
}

export interface ExperienceSkillInsertRow {
  experience_id: string;
  skill_raw: string;
  skill_id: string | null;
  resolved_at: string | null;
}

export interface DeriveExperiencesDeps {
  loadExtraction: (id: string) => Promise<{
    candidate_id: string;
    source_variant: SourceVariant;
    raw_output: ExtractionResult;
  } | null>;
  loadCatalog: () => Promise<CatalogSnapshot>;
  hasExistingExperiences: (extractionId: string) => Promise<boolean>;
  insertExperiences: (
    rows: ExperienceInsertRow[],
  ) => Promise<Array<{ temp_key: string; id: string }>>;
  insertExperienceSkills: (rows: ExperienceSkillInsertRow[]) => Promise<void>;
  now?: () => Date;
}

export interface DeriveExperiencesResult {
  skipped: boolean;
  experiencesInserted: number;
  skillsInserted: number;
}

export async function deriveExperiences(
  _extractionId: string,
  _deps: DeriveExperiencesDeps,
): Promise<DeriveExperiencesResult> {
  // F4-005 sub-B stub — compiles so the RED tests can fail by
  // assertion rather than by TS error.
  return { skipped: false, experiencesInserted: 0, skillsInserted: 0 };
}
