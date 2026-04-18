/**
 * Adversarial tests for the /api/search/semantic request schema.
 *
 * Exercises the Zod boundary so the route handler can trust its
 * parsed input. Full route-integration tests would require mocking
 * Next.js auth cookies + a Supabase client factory; we instead cover
 * the validation layer directly here and trust the service-level
 * integration tests for the rest of the pipeline.
 *
 * Focus on the inputs that must NOT reach the service:
 *   - empty / whitespace-only queries
 *   - over-sized queries (>2000 chars)
 *   - non-integer / out-of-range limits
 *   - unknown sourceType values
 *   - duplicates / over-sized sourceType arrays
 */
import { describe, expect, it } from 'vitest';

import { semanticSearchRequestSchema } from './route';

describe('semanticSearchRequestSchema', () => {
  it('accepts a minimal well-formed request', () => {
    const parsed = semanticSearchRequestSchema.parse({ query: 'senior backend' });
    expect(parsed.query).toBe('senior backend');
  });

  it('trims leading/trailing whitespace from the query', () => {
    const parsed = semanticSearchRequestSchema.parse({ query: '   hello  ' });
    expect(parsed.query).toBe('hello');
  });

  it('rejects an empty query string', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: '' })).toThrow();
  });

  it('rejects a whitespace-only query string (trim → empty → min(1) fails)', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: '     ' })).toThrow();
  });

  it('rejects a missing query field', () => {
    expect(() => semanticSearchRequestSchema.parse({})).toThrow();
  });

  it('rejects a non-string query', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: 42 })).toThrow();
    expect(() => semanticSearchRequestSchema.parse({ query: null })).toThrow();
    expect(() => semanticSearchRequestSchema.parse({ query: ['a'] })).toThrow();
    expect(() => semanticSearchRequestSchema.parse({ query: { toString: () => 'go' } })).toThrow();
  });

  it('rejects an over-sized query (>2000 chars)', () => {
    const huge = 'x'.repeat(2001);
    expect(() => semanticSearchRequestSchema.parse({ query: huge })).toThrow();
  });

  it('accepts a query at the 2000-char ceiling', () => {
    const atLimit = 'x'.repeat(2000);
    expect(() => semanticSearchRequestSchema.parse({ query: atLimit })).not.toThrow();
  });

  it('passes SQL-injection-looking strings through unchanged (parameterization handles it downstream)', () => {
    const payload = "'; DROP TABLE candidates; --";
    const parsed = semanticSearchRequestSchema.parse({ query: payload });
    // Schema is not a sanitizer; it just forwards the string.
    expect(parsed.query).toBe(payload);
  });

  it('rejects a negative limit', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: 'x', limit: -1 })).toThrow();
  });

  it('rejects a zero limit', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: 'x', limit: 0 })).toThrow();
  });

  it('rejects a non-integer limit', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: 'x', limit: 1.5 })).toThrow();
  });

  it('rejects a limit beyond 50', () => {
    expect(() => semanticSearchRequestSchema.parse({ query: 'x', limit: 51 })).toThrow();
    expect(() => semanticSearchRequestSchema.parse({ query: 'x', limit: 1_000_000 })).toThrow();
  });

  it('accepts a limit at the ceiling (50)', () => {
    const parsed = semanticSearchRequestSchema.parse({ query: 'x', limit: 50 });
    expect(parsed.limit).toBe(50);
  });

  it('rejects an unknown sourceType', () => {
    expect(() =>
      semanticSearchRequestSchema.parse({ query: 'x', sourceTypes: ['profile', 'resume'] }),
    ).toThrow();
  });

  it('rejects more than 4 sourceTypes', () => {
    expect(() =>
      semanticSearchRequestSchema.parse({
        query: 'x',
        sourceTypes: ['profile', 'notes', 'cv', 'evaluation', 'profile'],
      }),
    ).toThrow();
  });

  it('accepts the full valid sourceTypes set', () => {
    const parsed = semanticSearchRequestSchema.parse({
      query: 'x',
      sourceTypes: ['profile', 'notes', 'cv', 'evaluation'],
    });
    expect(parsed.sourceTypes).toEqual(['profile', 'notes', 'cv', 'evaluation']);
  });

  it('rejects a non-array sourceTypes', () => {
    expect(() =>
      semanticSearchRequestSchema.parse({ query: 'x', sourceTypes: 'profile' }),
    ).toThrow();
  });
});
