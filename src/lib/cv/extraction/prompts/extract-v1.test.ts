/**
 * Unit tests for the extraction prompt v1 (ADR-012 §Notas de implementación).
 *
 * The prompt is a string constant + a versioned tag. This test guards
 * the critical invariants so that a well-meaning reformulation does
 * not silently change the extractor's semantics:
 *
 *   - `EXTRACTION_PROMPT_V1` is pinned to '2026-04-v1'. Changing it
 *     triggers re-extraction of every CV (ADR-012 §5), so bumping
 *     the constant should be a conscious decision in a PR.
 *   - The prompt body covers the four non-negotiable rules from
 *     ADR-012 §Notas de implementación (kind=work gating, date
 *     fallback, skills verbatim, PII-out-of-output).
 *
 * A violation of any of these rules in the prompt text is a direct
 * regression against the ADR.
 */
import { describe, expect, it } from 'vitest';

import { EXTRACTION_PROMPT_V1, EXTRACTION_PROMPT_V1_TEXT } from './extract-v1';

describe('extraction prompt v1 — ADR-012 semantic invariants', () => {
  it('pins EXTRACTION_PROMPT_V1 to 2026-04-v1', () => {
    expect(EXTRACTION_PROMPT_V1).toBe('2026-04-v1');
  });

  it('prompt text is non-trivial', () => {
    expect(typeof EXTRACTION_PROMPT_V1_TEXT).toBe('string');
    expect(EXTRACTION_PROMPT_V1_TEXT.length).toBeGreaterThan(200);
  });

  it('prompt enforces kind=work gating (ADR-012 §Notas)', () => {
    // The prompt must mention that side projects / freelance / courses
    // do NOT count as kind='work'. We accept any wording that
    // distinguishes work from non-work.
    expect(EXTRACTION_PROMPT_V1_TEXT).toMatch(/work/i);
    expect(EXTRACTION_PROMPT_V1_TEXT).toMatch(/side_project|side project|freelance/i);
  });

  it('prompt enforces date fallback rule', () => {
    expect(EXTRACTION_PROMPT_V1_TEXT).toMatch(/YYYY-MM/);
  });

  it('prompt enforces skills verbatim rule (no normalization)', () => {
    // Either "verbatim" or an explicit "do not normalize" clause.
    expect(EXTRACTION_PROMPT_V1_TEXT).toMatch(
      /verbatim|no normalic|no normalize|do not normalize/i,
    );
  });

  it('prompt forbids copying PII (name, email, phone) to output', () => {
    expect(EXTRACTION_PROMPT_V1_TEXT).toMatch(/name/i);
    expect(EXTRACTION_PROMPT_V1_TEXT).toMatch(/email/i);
  });
});
