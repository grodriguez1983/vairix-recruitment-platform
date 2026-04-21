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
 * `YYYY-MM | YYYY-MM-DD | null` (enforced by Zod in `types.ts`).
 * The DB column is `date`, so we materialize `YYYY-MM` as
 * `YYYY-MM-01`. `null` stays `null` (end_date null = "present").
 *
 * Skill contract (ADR-012 §2): `skill_raw` is preserved verbatim.
 * Normalization lives *inside* the resolver — callers never see the
 * normalized form. A resolver hit populates `skill_id` + stamps
 * `resolved_at`; a miss leaves both `null` so the admin uncataloged
 * report (F4-009) can surface the raw string untouched.
 */
import { resolveSkill, type CatalogSnapshot } from '../../skills/resolver';

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

/**
 * `YYYY-MM` → `YYYY-MM-01`. `YYYY-MM-DD` passes through. `null` → `null`.
 * The Zod regex in `types.ts` already guarantees well-formed input, so
 * this is a shape fill-in, not a parser.
 */
function materializeDate(value: string | null): string | null {
  if (value === null) return null;
  return value.length === 7 ? `${value}-01` : value;
}

/**
 * Deterministic `resolved_at` — we stamp with the extraction_id so
 * callers can reason about idempotency (same input → same output)
 * without dragging `Date.now()` into a pure function. Sub-B may
 * override at write-time if policy ever needs wallclock.
 *
 * This intentionally is NOT an ISO timestamp; `resolved_at` in the
 * schema is `timestamptz`, but during derivation we only need a
 * non-null marker. Sub-B sets the real timestamp at insert.
 *
 * We return an ISO string so the TS type (`string | null`) is exact.
 */
function makeResolvedAt(extractionId: string): string {
  return `resolved:${extractionId}`;
}

export function deriveFromRawOutput(
  rawOutput: ExtractionResult,
  context: DeriveContext,
  catalog: CatalogSnapshot,
): DerivationResult {
  const experiences: ExperienceTuple[] = [];
  const experienceSkills: ExperienceSkillTuple[] = [];

  rawOutput.experiences.forEach((experience, index) => {
    const tempKey = `${context.extraction_id}:${index}`;

    experiences.push({
      temp_key: tempKey,
      candidate_id: context.candidate_id,
      extraction_id: context.extraction_id,
      source_variant: context.source_variant,
      kind: experience.kind,
      company: experience.company,
      title: experience.title,
      start_date: materializeDate(experience.start_date),
      end_date: materializeDate(experience.end_date),
      description: experience.description,
    });

    for (const rawSkill of experience.skills) {
      const resolution = resolveSkill(rawSkill, catalog);
      experienceSkills.push({
        experience_temp_key: tempKey,
        skill_raw: rawSkill,
        skill_id: resolution === null ? null : resolution.skill_id,
        resolved_at: resolution === null ? null : makeResolvedAt(context.extraction_id),
      });
    }
  });

  return { experiences, experienceSkills };
}
