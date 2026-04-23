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

// ADR-023: funciones del rol extraídas del título/intro del JD. Cada
// grupo es "al menos una de estas skills debe estar presente para
// calificar" (OR dentro del grupo; AND entre grupos). Lista vacía
// desactiva el gate.
export const RoleEssentialLabelEnum = z.enum(['frontend', 'backend', 'mobile', 'data', 'devops']);

export const RoleEssentialGroupSchema = z.object({
  label: RoleEssentialLabelEnum,
  // `skill_raw` values (pre-resolution). Cada uno DEBE aparecer
  // también en `requirements[].skill_raw` para que el resolver los
  // mapee a `skill_id`s del catálogo.
  skill_raws: z.array(z.string().min(1)).min(1),
});

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
  // ADR-023: backward-compat — default a lista vacía si el provider
  // viejo (prompt < v6) no lo emite. Empty array ≡ "no gate".
  role_essentials: z.array(RoleEssentialGroupSchema).default([]),
});

export type Seniority = z.infer<typeof SeniorityEnum>;
export type RequirementCategory = z.infer<typeof RequirementCategoryEnum>;
export type LanguageLevel = z.infer<typeof LanguageLevelEnum>;
export type Requirement = z.infer<typeof RequirementSchema>;
export type JobQueryLanguage = z.infer<typeof LanguageSchema>;
export type RoleEssentialLabel = z.infer<typeof RoleEssentialLabelEnum>;
export type RoleEssentialGroup = z.infer<typeof RoleEssentialGroupSchema>;
export type DecompositionResult = z.infer<typeof DecompositionResultSchema>;
