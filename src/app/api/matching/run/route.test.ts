/**
 * Adversarial tests for the POST /api/matching/run request schema
 * (F4-008 sub-D).
 *
 * Exercises the Zod boundary so the route handler can trust its
 * parsed input. Full route-integration tests live in
 * tests/integration/matching/run-match-job.test.ts.
 *
 * Focus on the inputs that MUST NOT reach the service:
 *   - malformed / missing job_query_id
 *   - non-UUID job_query_id
 *   - out-of-range top_n (<1, >100, non-integer)
 *   - extra unknown top-level fields (stripped, not errored)
 */
import { describe, expect, it } from 'vitest';

import { runMatchRequestSchema } from './route';

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('runMatchRequestSchema', () => {
  it('accepts a minimal well-formed request (defaults top_n to 10)', () => {
    const parsed = runMatchRequestSchema.parse({ job_query_id: VALID_UUID });
    expect(parsed.job_query_id).toBe(VALID_UUID);
    expect(parsed.top_n).toBe(10);
  });

  it('accepts an explicit top_n override', () => {
    const parsed = runMatchRequestSchema.parse({ job_query_id: VALID_UUID, top_n: 25 });
    expect(parsed.top_n).toBe(25);
  });

  it('rejects a missing job_query_id', () => {
    expect(() => runMatchRequestSchema.parse({})).toThrow();
  });

  it('rejects a non-string job_query_id', () => {
    expect(() => runMatchRequestSchema.parse({ job_query_id: 42 })).toThrow();
    expect(() => runMatchRequestSchema.parse({ job_query_id: null })).toThrow();
  });

  it('rejects a non-UUID job_query_id', () => {
    expect(() => runMatchRequestSchema.parse({ job_query_id: 'not-a-uuid' })).toThrow();
  });

  it('rejects top_n < 1', () => {
    expect(() => runMatchRequestSchema.parse({ job_query_id: VALID_UUID, top_n: 0 })).toThrow();
    expect(() => runMatchRequestSchema.parse({ job_query_id: VALID_UUID, top_n: -5 })).toThrow();
  });

  it('rejects top_n > 100', () => {
    expect(() => runMatchRequestSchema.parse({ job_query_id: VALID_UUID, top_n: 101 })).toThrow();
  });

  it('rejects non-integer top_n', () => {
    expect(() => runMatchRequestSchema.parse({ job_query_id: VALID_UUID, top_n: 3.5 })).toThrow();
  });

  it('strips unknown top-level keys', () => {
    const parsed = runMatchRequestSchema.parse({
      job_query_id: VALID_UUID,
      filters: { min_score: 50 }, // filters not implemented yet — stripped
      extra: 'ignored',
    } as unknown);
    expect(parsed).not.toHaveProperty('filters');
    expect(parsed).not.toHaveProperty('extra');
  });
});
