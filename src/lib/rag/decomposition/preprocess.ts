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
 */

// RED stub.
export function preprocess(_rawText: string): string {
  throw new Error('preprocess: not implemented');
}
