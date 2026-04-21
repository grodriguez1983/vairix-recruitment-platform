/**
 * Unit tests for `DecompositionError` (ADR-014 §6).
 *
 * The service wraps every failure mode in a `DecompositionError` so
 * that the caller (API route, worker) can discriminate on `code` and
 * decide the HTTP status or logging policy.
 *
 * Codes:
 *   - empty_input: raw_text is empty after preprocess
 *   - schema_violation: LLM output does not match DecompositionResultSchema
 *   - provider_failure: LLM call failed (HTTP non-2xx, network)
 *   - hallucinated_snippet: evidence_snippet is not a literal
 *     substring of raw_text (ADR-014 §3 rule 3)
 */
import { describe, expect, it } from 'vitest';

import { DecompositionError, type DecompositionErrorCode } from './errors';

describe('DecompositionError', () => {
  it('is an Error subclass so instanceof works', () => {
    const e = new DecompositionError('empty_input', 'nothing to decompose');
    expect(e).toBeInstanceOf(Error);
    expect(e).toBeInstanceOf(DecompositionError);
  });

  it('preserves code, message, and an optional cause', () => {
    const cause = new Error('boom');
    const e = new DecompositionError('provider_failure', 'LLM timed out', { cause });
    expect(e.code).toBe('provider_failure');
    expect(e.message).toBe('LLM timed out');
    expect(e.cause).toBe(cause);
  });

  it('has the right name for stack traces', () => {
    const e = new DecompositionError('schema_violation', 'bad shape');
    expect(e.name).toBe('DecompositionError');
  });

  it('accepts all documented codes (ADR-014 §6 + §3)', () => {
    const codes: DecompositionErrorCode[] = [
      'empty_input',
      'schema_violation',
      'provider_failure',
      'hallucinated_snippet',
    ];
    for (const c of codes) {
      const e = new DecompositionError(c, 'msg');
      expect(e.code).toBe(c);
    }
  });
});
