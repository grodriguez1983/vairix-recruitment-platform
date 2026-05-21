/**
 * Adversarial tests for the POST /api/matching/run/start request
 * schema (ADR-034 §1 — FE-driven chunked matching).
 *
 * The /start endpoint receives ONLY the job_query_id — top_n is
 * irrelevant at start because the endpoint does no slicing of
 * results. top_n lives in /finalize, which is the one that returns
 * the final `top` slice to the FE.
 *
 * Focus on inputs that MUST NOT reach the service:
 *   - missing job_query_id
 *   - non-UUID job_query_id
 *   - extra unknown top-level fields (stripped, not errored)
 *
 * Full route-integration tests live in
 * tests/integration/matching/start-match-job.test.ts.
 */
import { describe, expect, it } from 'vitest';

import { startMatchRequestSchema } from './route';

const VALID_UUID = '00000000-0000-0000-0000-000000000001';

describe('startMatchRequestSchema', () => {
  it('accepts a minimal well-formed request', () => {
    const parsed = startMatchRequestSchema.parse({ job_query_id: VALID_UUID });
    expect(parsed.job_query_id).toBe(VALID_UUID);
  });

  it('rejects a missing job_query_id', () => {
    expect(() => startMatchRequestSchema.parse({})).toThrow();
  });

  it('rejects a non-string job_query_id', () => {
    expect(() => startMatchRequestSchema.parse({ job_query_id: 42 })).toThrow();
    expect(() => startMatchRequestSchema.parse({ job_query_id: null })).toThrow();
  });

  it('rejects a non-UUID job_query_id', () => {
    expect(() => startMatchRequestSchema.parse({ job_query_id: 'not-a-uuid' })).toThrow();
  });

  it('strips unknown top-level keys', () => {
    const parsed = startMatchRequestSchema.parse({
      job_query_id: VALID_UUID,
      top_n: 25, // belongs to /finalize, not /start — must be stripped
      extra: 'ignored',
    } as unknown);
    expect(parsed).not.toHaveProperty('top_n');
    expect(parsed).not.toHaveProperty('extra');
  });
});
