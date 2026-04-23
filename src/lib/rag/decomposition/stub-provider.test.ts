/**
 * Unit tests for the deterministic `DecompositionProvider` stub
 * (ADR-014 §3).
 *
 * The stub is what integration tests use to exercise the decompose
 * service + persistence without burning OpenAI tokens or needing an
 * API key. The two invariants we pin here are:
 *
 *   - Same `rawText` ⇒ same `DecompositionResult` (so `content_hash`
 *     idempotency tests are reproducible across runs).
 *   - An injected `fixture` short-circuits the deterministic branch —
 *     integration tests can force an exact shape when asserting on
 *     downstream resolution behavior.
 */
import { describe, expect, it } from 'vitest';

import { createStubDecompositionProvider } from './stub-provider';
import { DecompositionResultSchema, type DecompositionResult } from './types';

describe('createStubDecompositionProvider', () => {
  it('uses sensible defaults for model and promptVersion', () => {
    const p = createStubDecompositionProvider();
    expect(p.model).toBe('stub-decomp-v1');
    expect(p.promptVersion).toBe('stub-decomp-prompt-v1');
  });

  it('honors caller-supplied model and promptVersion', () => {
    const p = createStubDecompositionProvider({
      model: 'stub-v9',
      promptVersion: 'stub-prompt-v9',
    });
    expect(p.model).toBe('stub-v9');
    expect(p.promptVersion).toBe('stub-prompt-v9');
  });

  it('returns a schema-valid DecompositionResult for any non-empty input', async () => {
    const p = createStubDecompositionProvider();
    const out = await p.decompose('Buscamos backend sr con 3+ años de Node.js');
    expect(() => DecompositionResultSchema.parse(out)).not.toThrow();
  });

  it('is deterministic: same rawText yields identical output', async () => {
    const p = createStubDecompositionProvider();
    const a = await p.decompose('Senior Node.js engineer, PostgreSQL');
    const b = await p.decompose('Senior Node.js engineer, PostgreSQL');
    expect(a).toEqual(b);
  });

  it('differs across different rawText (no cross-test collisions)', async () => {
    const p = createStubDecompositionProvider();
    const a = await p.decompose('text one');
    const b = await p.decompose('text two');
    expect(a).not.toEqual(b);
  });

  it('returns the fixture verbatim when one is provided', async () => {
    const fixture: DecompositionResult = {
      requirements: [
        {
          skill_raw: 'Go',
          min_years: 5,
          max_years: null,
          must_have: true,
          evidence_snippet: '5 años Go',
          category: 'technical',
          alternative_group_id: null,
        },
      ],
      seniority: 'lead',
      languages: [],
      notes: null,
    };
    const p = createStubDecompositionProvider({ fixture });
    const a = await p.decompose('anything');
    const b = await p.decompose('something else');
    expect(a).toEqual(fixture);
    expect(b).toEqual(fixture);
  });
});
