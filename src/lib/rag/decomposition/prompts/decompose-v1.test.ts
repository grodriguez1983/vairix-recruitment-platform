/**
 * Unit tests for the decomposition prompt v1 (ADR-014 §3).
 *
 * The prompt is a string constant + a versioned tag. This test guards
 * the non-negotiable semantic rules from ADR-014 so that a well-
 * meaning reformulation does not silently change the decomposer's
 * semantics:
 *
 *   - `DECOMPOSITION_PROMPT_V1` is pinned to '2026-04-v1'. Changing
 *     it invalidates every `job_queries.content_hash` (ADR-014 §5),
 *     so bumping the constant should be a conscious decision.
 *   - The prompt covers the four ADR-014 §3 rules: min_years only if
 *     explicit, must_have detection, evidence_snippet literal,
 *     category taxonomy.
 *   - The prompt forbids hallucination of requirements (the central
 *     risk in ADR-014 §3).
 *
 * A violation of any of these in the prompt text is a direct
 * regression against the ADR.
 */
import { describe, expect, it } from 'vitest';

import { DECOMPOSITION_PROMPT_V1, DECOMPOSITION_PROMPT_V1_TEXT } from './decompose-v1';

describe('decomposition prompt v1 — ADR-014 semantic invariants', () => {
  it('pins DECOMPOSITION_PROMPT_V1 to 2026-04-v2', () => {
    expect(DECOMPOSITION_PROMPT_V1).toBe('2026-04-v2');
  });

  it('prompt text is non-trivial', () => {
    expect(typeof DECOMPOSITION_PROMPT_V1_TEXT).toBe('string');
    expect(DECOMPOSITION_PROMPT_V1_TEXT.length).toBeGreaterThan(400);
  });

  it('prompt enforces min_years-only-if-explicit rule', () => {
    // ADR-014 §3: "min_years SOLO si el texto lo dice explícitamente".
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/min_years/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/explicit|explícit/i);
  });

  it('prompt enumerates must_have detection hints', () => {
    // At minimum one term from each bucket so the model can classify.
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/must_have/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/excluyente|imprescindible|required/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/deseable|plus|nice to have/i);
  });

  it('prompt requires evidence_snippet to be a literal substring', () => {
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/evidence_snippet/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/literal|substring|verbatim/i);
  });

  it('prompt documents the category taxonomy', () => {
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/technical/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/language/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/soft/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/other/i);
  });

  it('prompt forbids hallucinating requirements', () => {
    // ADR-014 §3: "si no estás seguro si algo es un requisito, NO lo
    // inventes" — prefer false negatives to fabricated requirements.
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(
      /do not invent|no inventes|no invent|don't invent/i,
    );
  });

  it('prompt requires skill_raw to be a short canonical name', () => {
    // Without this rule the LLM copies full sentences into skill_raw
    // (e.g. "5+ años construyendo features end-to-end en Ruby on
    // Rails (Rails 6+ idealmente)"), which the catalog resolver
    // (ADR-013) cannot match against slug/alias — every requirement
    // comes back unresolved and the match scorer degenerates to 0.0.
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/skill_raw/i);
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/short canonical|canonical name/i);
    // Explicit negative example: the prompt must warn against
    // emitting a full sentence or phrase as skill_raw.
    expect(DECOMPOSITION_PROMPT_V1_TEXT).toMatch(/not a (full )?sentence|not a phrase/i);
  });
});
