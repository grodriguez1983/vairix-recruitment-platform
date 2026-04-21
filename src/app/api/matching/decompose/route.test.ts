/**
 * Adversarial tests for the POST /api/matching/decompose request
 * schema (ADR-014 §3/§6).
 *
 * Exercises the Zod boundary so the route handler can trust its
 * parsed input. Full route-integration tests would require mocking
 * Next.js auth cookies + a Supabase client factory; we instead
 * cover the validation layer here and trust
 * tests/integration/rag/decompose-job-query.test.ts for the service
 * pipeline.
 *
 * Focus on the inputs that MUST NOT reach the service:
 *   - empty / whitespace-only raw_text (service would throw
 *     'empty_input' anyway, but the route should 400 earlier)
 *   - over-sized raw_text (>20000 chars)
 *   - non-string raw_text
 *   - unknown / extra top-level fields (strict schema)
 */
import { describe, expect, it } from 'vitest';

import { decomposeRequestSchema } from './route';

describe('decomposeRequestSchema', () => {
  it('accepts a minimal well-formed request', () => {
    const parsed = decomposeRequestSchema.parse({
      rawText: 'Buscamos backend sr con 3+ años Node.js',
    });
    expect(parsed.rawText).toBe('Buscamos backend sr con 3+ años Node.js');
  });

  it('rejects a missing rawText', () => {
    expect(() => decomposeRequestSchema.parse({})).toThrow();
  });

  it('rejects a non-string rawText', () => {
    expect(() => decomposeRequestSchema.parse({ rawText: 42 })).toThrow();
    expect(() => decomposeRequestSchema.parse({ rawText: null })).toThrow();
    expect(() => decomposeRequestSchema.parse({ rawText: ['x'] })).toThrow();
  });

  it('rejects empty rawText', () => {
    expect(() => decomposeRequestSchema.parse({ rawText: '' })).toThrow();
  });

  it('rejects whitespace-only rawText', () => {
    expect(() => decomposeRequestSchema.parse({ rawText: '   \n\t   ' })).toThrow();
  });

  it('rejects rawText larger than 20000 chars', () => {
    expect(() => decomposeRequestSchema.parse({ rawText: 'x'.repeat(20001) })).toThrow();
  });

  it('accepts rawText exactly at the 20000-char ceiling', () => {
    expect(() => decomposeRequestSchema.parse({ rawText: 'x'.repeat(20000) })).not.toThrow();
  });

  it('passes injection-looking strings through unchanged', () => {
    const payload = "'; DROP TABLE job_queries; --";
    const parsed = decomposeRequestSchema.parse({ rawText: payload });
    expect(parsed.rawText).toBe(payload);
  });

  it('strips unknown top-level keys', () => {
    const parsed = decomposeRequestSchema.parse({
      rawText: 'valid text',
      extra_field: 'ignored',
    } as unknown);
    expect(parsed).not.toHaveProperty('extra_field');
  });
});
