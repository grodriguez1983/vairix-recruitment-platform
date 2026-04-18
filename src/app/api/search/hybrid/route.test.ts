/**
 * Adversarial tests for the /api/search/hybrid request schema.
 *
 * Same rationale as the semantic-route tests: we cover the Zod
 * boundary here so the handler can trust parsed input, and rely on
 * hybrid-search integration tests for the service behavior.
 *
 * Key differences vs the semantic schema:
 *   - `query` is nullable (null means "structured-only" mode).
 *   - `filters` is a nested object with its own coercion and
 *     UUID / datetime validation.
 *   - Empty strings should be coerced to null (emptyToNull) so the
 *     UI can send form defaults without forcing the server to
 *     handle each case.
 */
import { describe, expect, it } from 'vitest';

import { hybridSearchRequestSchema } from './route';

describe('hybridSearchRequestSchema', () => {
  it('accepts an empty object (all defaults)', () => {
    const parsed = hybridSearchRequestSchema.parse({});
    expect(parsed.query).toBeNull();
    expect(parsed.filters).toEqual({
      status: null,
      rejectedAfter: null,
      rejectedBefore: null,
      jobId: null,
    });
  });

  it('coerces an empty/whitespace query string to null', () => {
    expect(hybridSearchRequestSchema.parse({ query: '' }).query).toBeNull();
    expect(hybridSearchRequestSchema.parse({ query: '   ' }).query).toBeNull();
  });

  it('trims and keeps a real query string', () => {
    const parsed = hybridSearchRequestSchema.parse({ query: '  senior backend  ' });
    expect(parsed.query).toBe('senior backend');
  });

  it('rejects an over-sized query (>2000 chars)', () => {
    const huge = 'x'.repeat(2001);
    expect(() => hybridSearchRequestSchema.parse({ query: huge })).toThrow();
  });

  it('rejects an unknown application status', () => {
    expect(() =>
      hybridSearchRequestSchema.parse({
        filters: { status: 'deceased' },
      }),
    ).toThrow();
  });

  it('accepts the four valid application statuses', () => {
    for (const status of ['active', 'rejected', 'hired', 'withdrawn'] as const) {
      expect(() => hybridSearchRequestSchema.parse({ filters: { status } })).not.toThrow();
    }
  });

  it('coerces empty-string status to null', () => {
    const parsed = hybridSearchRequestSchema.parse({ filters: { status: '' } });
    expect(parsed.filters.status).toBeNull();
  });

  it('rejects a jobId that is not a UUID', () => {
    expect(() => hybridSearchRequestSchema.parse({ filters: { jobId: 'not-a-uuid' } })).toThrow();
    expect(() => hybridSearchRequestSchema.parse({ filters: { jobId: '123' } })).toThrow();
    // SQL-injection-looking payload must fail the uuid check.
    expect(() =>
      hybridSearchRequestSchema.parse({
        filters: { jobId: "' OR 1=1 --" },
      }),
    ).toThrow();
  });

  it('accepts a well-formed UUID jobId', () => {
    const jobId = '11111111-2222-3333-4444-555555555555';
    const parsed = hybridSearchRequestSchema.parse({ filters: { jobId } });
    expect(parsed.filters.jobId).toBe(jobId);
  });

  it('coerces empty-string jobId to null', () => {
    const parsed = hybridSearchRequestSchema.parse({ filters: { jobId: '' } });
    expect(parsed.filters.jobId).toBeNull();
  });

  it('rejects a non-ISO rejectedAfter', () => {
    expect(() =>
      hybridSearchRequestSchema.parse({ filters: { rejectedAfter: 'yesterday' } }),
    ).toThrow();
    expect(() =>
      hybridSearchRequestSchema.parse({ filters: { rejectedAfter: '2024-01-01' } }),
    ).toThrow();
  });

  it('accepts an ISO-with-offset rejectedAfter', () => {
    const parsed = hybridSearchRequestSchema.parse({
      filters: { rejectedAfter: '2024-06-01T10:00:00Z' },
    });
    expect(parsed.filters.rejectedAfter).toBe('2024-06-01T10:00:00Z');
  });

  it('coerces empty-string date filters to null', () => {
    const parsed = hybridSearchRequestSchema.parse({
      filters: { rejectedAfter: '', rejectedBefore: '   ' },
    });
    expect(parsed.filters.rejectedAfter).toBeNull();
    expect(parsed.filters.rejectedBefore).toBeNull();
  });

  it('rejects limit outside [1, 50]', () => {
    expect(() => hybridSearchRequestSchema.parse({ limit: 0 })).toThrow();
    expect(() => hybridSearchRequestSchema.parse({ limit: -5 })).toThrow();
    expect(() => hybridSearchRequestSchema.parse({ limit: 51 })).toThrow();
    expect(() => hybridSearchRequestSchema.parse({ limit: 2.5 })).toThrow();
  });

  it('rejects an unknown sourceType', () => {
    expect(() => hybridSearchRequestSchema.parse({ sourceTypes: ['cv', 'resume'] })).toThrow();
  });

  it('rejects more than 4 sourceTypes', () => {
    expect(() =>
      hybridSearchRequestSchema.parse({
        sourceTypes: ['profile', 'notes', 'cv', 'evaluation', 'profile'],
      }),
    ).toThrow();
  });

  it('passes SQL-injection-looking query through (parameterization downstream)', () => {
    const payload = "'; DROP TABLE embeddings; --";
    const parsed = hybridSearchRequestSchema.parse({ query: payload });
    expect(parsed.query).toBe(payload);
  });
});
