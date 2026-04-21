/**
 * Extraction prompt v1 (ADR-012 §Notas de implementación).
 *
 * The prompt body and version tag are exported together so that the
 * provider can hash `(model, promptVersion)` and the hook in
 * extract-v1.test.ts can pin the version string.
 *
 * IMPORTANT: bumping `EXTRACTION_PROMPT_V1` invalidates every
 * `candidate_extractions.content_hash` and triggers a re-extract of
 * every CV (ADR-012 §5). Only bump the version in a conscious PR —
 * typo fixes or reformulations with no semantic change go under the
 * same version.
 */

export const EXTRACTION_PROMPT_V1 = '2026-04-v1';

// Kept as a template literal so prettier doesn't reflow the rules
// into a hard-to-read single line. These are the four non-negotiable
// rules from ADR-012 §Notas de implementación; the tests guard them.
export const EXTRACTION_PROMPT_V1_TEXT = `You are a CV structured-extraction engine. You receive the plain
text of a CV and return a JSON object that conforms exactly to the
ExtractionResult schema provided in response_format.

Rules (do not break):

1. kind='work' applies ONLY to roles with an explicit employer and a
   clear employment duration. Side projects, freelance gigs,
   hackathons, academic projects, and short courses must be
   kind='side_project'. Formal studies go under kind='education'.

2. Dates use YYYY-MM or YYYY-MM-DD. If only the year is known,
   assume January (YYYY-01). If no year at all is present, return
   null for that date. end_date = null means the experience is
   ongoing ("present").

3. Skills must be copied verbatim from the CV (e.g. "React.js",
   "ReactJS", and "react" can coexist). Do NOT normalize, translate,
   or deduplicate — normalization is handled downstream by the
   skills catalog resolver.

4. Do NOT copy the candidate's personal identifiers (full name,
   email, phone number) into the output. These are already stored
   elsewhere and re-emitting them to the JSON would leak PII into
   debug logs.

Return ONLY the JSON object. No prose, no markdown fences.
`;
