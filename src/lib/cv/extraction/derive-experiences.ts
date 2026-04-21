/**
 * `deriveExperiences(extractionId, deps)` — F4-005 sub-B.
 *
 * Service layer between the pure tuple builder
 * (`./derivation.deriveFromRawOutput`) and the DB. All I/O is
 * injected so the unit suite doesn't need Supabase; sub-C's
 * integration test exercises the real SQL path.
 *
 * Contract:
 *   1. Load the extraction row. If missing, throw — the worker
 *      should not have queued a non-existent id.
 *   2. Idempotency guard: if `hasExistingExperiences(extraction_id)`
 *      is true, skip all writes and return `{ skipped: true, ... 0 }`.
 *   3. Derive pure tuples; insert experiences; receive real ids;
 *      stitch onto skill tuples via `temp_key`; insert skills.
 *   4. `resolved_at` is stamped at *this* layer with a real ISO
 *      timestamp (via `deps.now()`), overwriting sub-A's
 *      deterministic marker. Null stays null for uncataloged rows.
 */
import type { CatalogSnapshot } from '../../skills/resolver';

import { deriveFromRawOutput } from './derivation';
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
  extractionId: string,
  deps: DeriveExperiencesDeps,
): Promise<DeriveExperiencesResult> {
  const extraction = await deps.loadExtraction(extractionId);
  if (extraction === null) {
    throw new Error(`deriveExperiences: extraction not found: ${extractionId}`);
  }

  if (await deps.hasExistingExperiences(extractionId)) {
    return { skipped: true, experiencesInserted: 0, skillsInserted: 0 };
  }

  const catalog = await deps.loadCatalog();
  const tuples = deriveFromRawOutput(
    extraction.raw_output,
    {
      candidate_id: extraction.candidate_id,
      extraction_id: extractionId,
      source_variant: extraction.source_variant,
    },
    catalog,
  );

  if (tuples.experiences.length === 0) {
    return { skipped: false, experiencesInserted: 0, skillsInserted: 0 };
  }

  const expRows: ExperienceInsertRow[] = tuples.experiences.map((e) => ({
    temp_key: e.temp_key,
    candidate_id: e.candidate_id,
    extraction_id: e.extraction_id,
    source_variant: e.source_variant,
    kind: e.kind,
    company: e.company,
    title: e.title,
    start_date: e.start_date,
    end_date: e.end_date,
    description: e.description,
  }));
  const inserted = await deps.insertExperiences(expRows);

  if (tuples.experienceSkills.length === 0) {
    return {
      skipped: false,
      experiencesInserted: inserted.length,
      skillsInserted: 0,
    };
  }

  const keyToId = new Map<string, string>();
  for (const row of inserted) {
    keyToId.set(row.temp_key, row.id);
  }
  const nowIso = (deps.now ?? (() => new Date()))().toISOString();
  const skillRows: ExperienceSkillInsertRow[] = tuples.experienceSkills.map((s) => {
    const experienceId = keyToId.get(s.experience_temp_key);
    if (experienceId === undefined) {
      throw new Error(
        `deriveExperiences: no inserted experience for temp_key ${s.experience_temp_key}`,
      );
    }
    return {
      experience_id: experienceId,
      skill_raw: s.skill_raw,
      skill_id: s.skill_id,
      resolved_at: s.skill_id === null ? null : nowIso,
    };
  });
  await deps.insertExperienceSkills(skillRows);

  return {
    skipped: false,
    experiencesInserted: inserted.length,
    skillsInserted: skillRows.length,
  };
}
