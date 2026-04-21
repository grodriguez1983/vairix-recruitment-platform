/**
 * Preprocessor for job-description raw_text (ADR-014 §1).
 *
 * Normalizes the string before hashing and before handing it to the
 * LLM. Defines what "same input" means for cache-hit purposes — two
 * user submissions that differ only in whitespace or HTML noise must
 * produce the same `content_hash`.
 *
 * Pipeline (ADR-014 §1):
 *   1. strip HTML tags (paste from doc editors often includes
 *      <span>, <p>, <br>).
 *   2. collapse runs of whitespace (spaces, tabs, newlines, CR) to
 *      a single space.
 *   3. trim leading / trailing whitespace.
 *
 * Casing, accents, and internal punctuation are preserved — those
 * are semantically relevant and the LLM will handle them.
 *
 * The HTML stripper is intentionally naive (`<[^>]*>`): we never
 * interpret HTML entities or attribute content. Job descriptions
 * come from plaintext paste or trivial formatting, not from arbitrary
 * external HTML. A recruiter-controlled XSS vector would be a
 * separate threat.
 */

export function preprocess(rawText: string): string {
  // Step 1: strip HTML tags. Replace with space so "<br/>React" does
  // not become "React" concatenated with the previous word.
  const withoutTags = rawText.replace(/<[^>]*>/g, ' ');
  // Step 2: collapse any whitespace run (spaces, tabs, CR, LF) to one
  // space. Step 3: trim.
  return withoutTags.replace(/\s+/g, ' ').trim();
}
