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

// Markers the LLM emits to mean "still in this role". The prompt
// (§Notas de implementación, rule 2) tells it to use null instead but
// gpt-4o-mini disobeys in ~5% of cases. Case-insensitive match.
const PRESENT_MARKERS = new Set([
  'present',
  'current',
  'actual', // es: "Actual"
  'now',
  'ongoing',
  'in progress',
  'vigente', // es
  'presente', // es
  'currently', // en
]);

/**
 * Coerces known LLM date drift to a string the strict regex accepts,
 * or to null. Returns the input unchanged when it's already valid,
 * already null, or non-string (let Zod surface the original error).
 *
 * - "Present" / "Current" / etc. → null (per prompt rule §2)
 * - "YYYY" alone → "YYYY-01" (prompt says pad to January)
 * - "YYYY/MM" or "YYYY/MM/DD" → swap slashes for dashes
 * - "YYYY-M" (single-digit month) → "YYYY-0M"
 *
 * Free-form prose ("March 2024") is left untouched so the regex
 * rejects it loudly — silently turning unparseable strings into null
 * would destroy real signal from the CV.
 */
function coerceLlmDateDrift(input: unknown): unknown {
  if (typeof input !== 'string') return input;
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (PRESENT_MARKERS.has(trimmed.toLowerCase())) return null;
  // YYYY alone → YYYY-01.
  if (/^\d{4}$/.test(trimmed)) return `${trimmed}-01`;
  // YYYY/MM or YYYY/MM/DD → dash form.
  const slashMatch = /^(\d{4})\/(\d{1,2})(?:\/(\d{1,2}))?$/.exec(trimmed);
  if (slashMatch) {
    const [, yyyy, mm, dd] = slashMatch;
    const month = mm!.padStart(2, '0');
    return dd ? `${yyyy}-${month}-${dd.padStart(2, '0')}` : `${yyyy}-${month}`;
  }
  // YYYY-M → YYYY-0M (and YYYY-M-D → YYYY-0M-0D).
  const dashMatch = /^(\d{4})-(\d{1,2})(?:-(\d{1,2}))?$/.exec(trimmed);
  if (dashMatch) {
    const [, yyyy, mm, dd] = dashMatch;
    const month = mm!.padStart(2, '0');
    return dd ? `${yyyy}-${month}-${dd.padStart(2, '0')}` : `${yyyy}-${month}`;
  }
  return input;
}

// YYYY-MM or YYYY-MM-DD (partial ISO-8601). Null = unknown / present.
// Wrapped in z.preprocess so known LLM drift patterns are normalized
// before the strict regex; unrecognized strings still fail loudly.
// Nullability is baked in so present-marker coercion (→ null) is
// accepted by the inner schema instead of failing "expected string".
const IsoPartialDate = z.preprocess(
  coerceLlmDateDrift,
  z
    .string()
    .regex(/^\d{4}-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?$/, {
      message: 'date must be YYYY-MM or YYYY-MM-DD',
    })
    .nullable(),
);

export const ExperienceKindSchema = z.enum(['work', 'side_project', 'education']);
export const SourceVariantSchema = z.enum(['linkedin_export', 'cv_primary']);

export const ExperienceSchema = z.object({
  kind: ExperienceKindSchema,
  company: z.string().nullable(),
  title: z.string().nullable(),
  start_date: IsoPartialDate,
  end_date: IsoPartialDate,
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
