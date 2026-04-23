/**
 * Zod schema + TS types for `DecompositionResult` (ADR-014 §2).
 *
 * Single contract shared by every decomposition backend (OpenAI LLM,
 * deterministic stub). The same schema is handed to OpenAI as
 * `response_format: { type: 'json_schema', strict: true }` — the
 * provider enforces the shape server-side, and we validate again
 * locally after parsing.
 *
 * Unknown top-level keys are stripped (not `.passthrough()`): the
 * persisted `decomposed_json` must be deterministic, so schema bumps
 * are an explicit ADR decision, not a silent extension.
 *
 * Contract invariants (ADR-014 §2–§3):
 *   - `evidence_snippet` is a LITERAL substring of raw_text — empty
 *     strings are rejected because "no evidence" is not a legal state.
 *   - `min_years` / `max_years` are null when unspecified; ADR-014 §3
 *     explicitly forbids the LLM from inferring years from seniority.
 *     Non-null values must be non-negative integers.
 *   - `requirements` covers technical / language-tagged / soft
 *     requisites. Languages themselves are duplicated in `languages[]`
 *     because they hit a different filter (ADR-014 §2 separation).
 *   - `notes` captures unstructured residue ("full-time", "CABA")
 *     that is NOT atomized in Fase 1.
 */
import { z } from 'zod';

export const SeniorityEnum = z.enum(['junior', 'semi_senior', 'senior', 'lead', 'unspecified']);

export const RequirementCategoryEnum = z.enum(['technical', 'language', 'soft', 'other']);

export const LanguageLevelEnum = z.enum([
  'basic',
  'intermediate',
  'advanced',
  'native',
  'unspecified',
]);

const YearsField = z.number().int().min(0).nullable();

export const RequirementSchema = z.object({
  skill_raw: z.string().min(1),
  min_years: YearsField,
  max_years: YearsField,
  must_have: z.boolean(),
  evidence_snippet: z.string().min(1),
  category: RequirementCategoryEnum,
  // ADR-021: non-null id means this requirement is part of an OR
  // group with every other requirement sharing the same id. null
  // means singleton (group of 1). Empty string is rejected
  // explicitly — it would be ambiguous with null.
  alternative_group_id: z.string().min(1).nullable(),
});

export const LanguageSchema = z.object({
  name: z.string().min(1),
  level: LanguageLevelEnum,
  must_have: z.boolean(),
});

export const DecompositionResultSchema = z.object({
  requirements: z.array(RequirementSchema),
  seniority: SeniorityEnum,
  languages: z.array(LanguageSchema),
  notes: z.string().nullable(),
});

export type Seniority = z.infer<typeof SeniorityEnum>;
export type RequirementCategory = z.infer<typeof RequirementCategoryEnum>;
export type LanguageLevel = z.infer<typeof LanguageLevelEnum>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type JobQueryLanguage = z.infer<typeof LanguageSchema>;
export type DecompositionResult = z.infer<typeof DecompositionResultSchema>;
