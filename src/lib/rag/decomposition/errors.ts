/**
 * Domain error for the decomposition pipeline (ADR-014 §6).
 *
 * The service wraps every failure mode in a `DecompositionError` so
 * callers (API route, worker) can discriminate on `code` and decide
 * the HTTP status or logging policy. Using a plain `Error` would
 * force callers to string-match messages, which is brittle.
 *
 * Codes:
 *   - empty_input: raw_text is empty after preprocess (ADR-014 §6).
 *   - schema_violation: LLM output does not match
 *     DecompositionResultSchema after 1 retry (ADR-014 §2).
 *   - provider_failure: LLM call failed (HTTP non-2xx, network).
 *   - hallucinated_snippet: evidence_snippet is not a literal
 *     substring of raw_text (ADR-014 §3 rule 3). Detected in the
 *     service layer, not the provider.
 */

export type DecompositionErrorCode =
  | 'empty_input'
  | 'schema_violation'
  | 'provider_failure'
  | 'hallucinated_snippet';

export class DecompositionError extends Error {
  readonly code: DecompositionErrorCode;

  constructor(code: DecompositionErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DecompositionError';
    this.code = code;
  }
}
