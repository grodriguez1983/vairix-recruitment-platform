/**
 * Zod schema + TS type for `ExtractionResult` (ADR-012 §2).
 *
 * Single contract shared by every backend (LLM, future LinkedIn
 * parser, stub). It is also handed to OpenAI as
 * `response_format: { type: 'json_schema' }` — the provider enforces
 * the shape server-side, and we validate again locally after parsing.
 *
 * Date contract (ADR-012 prompt rules, §Notas de implementación):
 *   - `YYYY-MM` or `YYYY-MM-DD`. If month is missing, the prompt
 *     forces January. If year is missing, the value must be null.
 *   - `end_date === null` means "present".
 *
 * Skills contract (ADR-012 §2 invariant): strings come out as they
 * appear in the CV. Normalization lives downstream (ADR-013 resolver).
 * A backend that "cleans" a skill breaks this contract.
 *
 * Unknown top-level keys are stripped (not `.passthrough()`). This
 * keeps `raw_output` persisted in Postgres minimal and deterministic
 * — if a backend adds fields, they need a schema bump + an ADR, not
 * a silent extension.
 */
import { z } from 'zod';

// YYYY-MM or YYYY-MM-DD (partial ISO-8601). Null = unknown / present.
const IsoPartialDate = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/, {
  message: 'date must be YYYY-MM or YYYY-MM-DD',
});

export const ExperienceKindSchema = z.enum(['work', 'side_project', 'education']);
export const SourceVariantSchema = z.enum(['linkedin_export', 'cv_primary']);

export const ExperienceSchema = z.object({
  kind: ExperienceKindSchema,
  company: z.string().nullable(),
  title: z.string().nullable(),
  start_date: IsoPartialDate.nullable(),
  end_date: IsoPartialDate.nullable(),
  description: z.string().nullable(),
  skills: z.array(z.string()),
});

export const LanguageSchema = z.object({
  name: z.string(),
  level: z.string().nullable(),
});

export const ExtractionResultSchema = z.object({
  source_variant: SourceVariantSchema,
  experiences: z.array(ExperienceSchema),
  languages: z.array(LanguageSchema),
});

export type ExperienceKind = z.infer<typeof ExperienceKindSchema>;
export type SourceVariant = z.infer<typeof SourceVariantSchema>;
export type Experience = z.infer<typeof ExperienceSchema>;
export type Language = z.infer<typeof LanguageSchema>;
export type ExtractionResult = z.infer<typeof ExtractionResultSchema>;
