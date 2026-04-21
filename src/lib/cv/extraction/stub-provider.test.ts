/**
 * Unit tests for `createStubExtractionProvider` (ADR-012 §3).
 *
 * The stub is the deterministic test double for `ExtractionProvider`.
 * Contract:
 *
 *   - `model` + `promptVersion` are exposed (worker needs them for
 *     `content_hash` + idempotency).
 *   - `extract(parsedText)` returns a valid `ExtractionResult`.
 *   - Same input → same output (determinism is how the worker test
 *     suite verifies idempotency).
 *   - The caller can inject a fixture so a test can assert on the
 *     exact shape without coupling to the stub's default.
 *   - The stub NEVER hits the network (that's the whole point). We
 *     don't test that directly, but we keep the implementation tiny.
 */
import { describe, expect, it } from 'vitest';

import { createStubExtractionProvider } from './stub-provider';
import { ExtractionResultSchema, type ExtractionResult } from './types';

describe('createStubExtractionProvider — ADR-012 §3 test double', () => {
  it('exposes model + promptVersion as stable strings', () => {
    const p = createStubExtractionProvider();
    expect(typeof p.model).toBe('string');
    expect(p.model.length).toBeGreaterThan(0);
    expect(typeof p.promptVersion).toBe('string');
    expect(p.promptVersion.length).toBeGreaterThan(0);
  });

  it('allows overriding model + promptVersion (to simulate bumps)', async () => {
    const p = createStubExtractionProvider({
      model: 'gpt-stub-v2',
      promptVersion: '2099-01-v7',
    });
    expect(p.model).toBe('gpt-stub-v2');
    expect(p.promptVersion).toBe('2099-01-v7');
  });

  it('returns a Zod-valid ExtractionResult for any non-empty text', async () => {
    const p = createStubExtractionProvider();
    const out = await p.extract('some parsed cv text');
    expect(() => ExtractionResultSchema.parse(out)).not.toThrow();
  });

  it('is deterministic — same input twice returns identical output', async () => {
    const p = createStubExtractionProvider();
    const a = await p.extract('identical text');
    const b = await p.extract('identical text');
    expect(a).toEqual(b);
  });

  it('yields different outputs for different inputs (non-degenerate)', async () => {
    const p = createStubExtractionProvider();
    const a = await p.extract('text one');
    const b = await p.extract('text two, different');
    expect(a).not.toEqual(b);
  });

  it('accepts a fixture to force exact output (integration seeding)', async () => {
    const fixture: ExtractionResult = {
      source_variant: 'linkedin_export',
      experiences: [
        {
          kind: 'work',
          company: 'Fixture Corp',
          title: 'Staff Engineer',
          start_date: '2020-01',
          end_date: null,
          description: null,
          skills: ['TypeScript'],
        },
      ],
      languages: [{ name: 'English', level: 'C2' }],
    };
    const p = createStubExtractionProvider({ fixture });
    const out = await p.extract('whatever');
    expect(out).toEqual(fixture);
  });

  it('handles empty string (returns valid empty result, does not throw)', async () => {
    const p = createStubExtractionProvider();
    const out = await p.extract('');
    expect(() => ExtractionResultSchema.parse(out)).not.toThrow();
  });
});
