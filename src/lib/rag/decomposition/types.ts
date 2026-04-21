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
 *   - `requirements` covers technical / language-tagged / soft
 *     requisites. Languages themselves are duplicated in `languages[]`
 *     because they hit a different filter (ADR-014 §2 separation).
 *   - `notes` captures unstructured residue ("full-time", "CABA")
 *     that is NOT atomized in Fase 1.
 */
import { z } from 'zod';

// Intentionally STUB: provoke RED on every test in types.test.ts.
export const SeniorityEnum = z.never() as unknown as z.ZodTypeAny;
export const RequirementCategoryEnum = z.never() as unknown as z.ZodTypeAny;
export const LanguageLevelEnum = z.never() as unknown as z.ZodTypeAny;
export const RequirementSchema = z.never() as unknown as z.ZodTypeAny;
export const LanguageSchema = z.never() as unknown as z.ZodTypeAny;
export const DecompositionResultSchema = z.never() as unknown as z.ZodTypeAny;

export type Seniority = 'junior' | 'semi_senior' | 'senior' | 'lead' | 'unspecified';
export type RequirementCategory = 'technical' | 'language' | 'soft' | 'other';
export type LanguageLevel = 'basic' | 'intermediate' | 'advanced' | 'native' | 'unspecified';

export type Requirement = {
  skill_raw: string;
  min_years: number | null;
  max_years: number | null;
  must_have: boolean;
  evidence_snippet: string;
  category: RequirementCategory;
};

export type JobQueryLanguage = {
  name: string;
  level: LanguageLevel;
  must_have: boolean;
};

export type DecompositionResult = {
  requirements: Requirement[];
  seniority: Seniority;
  languages: JobQueryLanguage[];
  notes: string | null;
};
