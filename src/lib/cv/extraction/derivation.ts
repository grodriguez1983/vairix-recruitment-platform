/**
 * Pure derivation: `ExtractionResult.raw_output` → insert tuples for
 * `candidate_experiences` + `experience_skills` (ADR-012 §7, ADR-013 §3).
 *
 * No I/O here. Callers pass a pre-built `CatalogSnapshot` (ADR-013 §2)
 * and get back two flat arrays ready to hand to the DB layer in
 * sub-B. The stitching between the two arrays is done via a
 * per-experience `temp_key` because the real `experience_id` only
 * exists after the insert returns.
 *
 * Date contract: `raw_output.start_date / end_date` are
 * `YYYY-MM | YYYY-MM-DD | null` (enforced by Zod in types.ts). The
 * DB column is `date`, so we materialize `YYYY-MM` as
 * `YYYY-MM-01`. `null` stays `null` (end_date null = "present").
 */
import type { CatalogSnapshot } from '../../skills/resolver';

import type { ExtractionResult, ExperienceKind, SourceVariant } from './types';

export interface DeriveContext {
  candidate_id: string;
  extraction_id: string;
  source_variant: SourceVariant;
}

export interface ExperienceTuple {
  temp_key: string;
  candidate_id: string;
  extraction_id: string;
  source_variant: SourceVariant;
  kind: ExperienceKind;
  company: string | null;
  title: string | null;
  start_date: string | null;
  end_date: string | null;
  description: string | null;
}

export interface ExperienceSkillTuple {
  experience_temp_key: string;
  skill_raw: string;
  skill_id: string | null;
  resolved_at: string | null;
}

export interface DerivationResult {
  experiences: ExperienceTuple[];
  experienceSkills: ExperienceSkillTuple[];
}

export function deriveFromRawOutput(
  _rawOutput: ExtractionResult,
  _context: DeriveContext,
  _catalog: CatalogSnapshot,
): DerivationResult {
  // F4-005 sub-A stub — compiles so the RED tests can import the
  // symbols and fail by assertion rather than by TS error.
  return { experiences: [], experienceSkills: [] };
}
