/**
 * Adversarial tests for the POST /api/matching/run/finalize request
 * schema (ADR-034 §3).
 *
 * Focus on inputs that MUST NOT reach the service:
 *   - missing run_id
 *   - non-UUID run_id
 *   - top_n outside [1..100]
 *   - excluded entries with non-UUID candidate_id or skill ids
 *   - extra unknown fields (stripped, not errored)
 */
import { describe, expect, it } from 'vitest';

import { finalizeMatchRequestSchema } from './route';

const RUN_UUID = '00000000-0000-0000-0000-000000000001';
const CAND_UUID = '00000000-0000-0000-0000-000000000010';
const SKILL_UUID = '00000000-0000-0000-0000-000000000100';

describe('finalizeMatchRequestSchema', () => {
  it('accepts a minimal well-formed request (defaults applied)', () => {
    const parsed = finalizeMatchRequestSchema.parse({ run_id: RUN_UUID });
    expect(parsed.run_id).toBe(RUN_UUID);
    expect(parsed.top_n).toBe(10);
    expect(parsed.excluded).toEqual([]);
  });

  it('accepts excluded entries with multiple missing skill ids', () => {
    const parsed = finalizeMatchRequestSchema.parse({
      run_id: RUN_UUID,
      top_n: 25,
      excluded: [
        {
          candidate_id: CAND_UUID,
          missing_must_have_skill_ids: [SKILL_UUID],
        },
      ],
    });
    expect(parsed.top_n).toBe(25);
    expect(parsed.excluded).toHaveLength(1);
  });

  it('rejects a missing run_id', () => {
    expect(() => finalizeMatchRequestSchema.parse({})).toThrow();
  });

  it('rejects a non-UUID run_id', () => {
    expect(() => finalizeMatchRequestSchema.parse({ run_id: 'nope' })).toThrow();
  });

  it('rejects top_n <= 0', () => {
    expect(() => finalizeMatchRequestSchema.parse({ run_id: RUN_UUID, top_n: 0 })).toThrow();
    expect(() => finalizeMatchRequestSchema.parse({ run_id: RUN_UUID, top_n: -5 })).toThrow();
  });

  it('rejects top_n > 100', () => {
    expect(() => finalizeMatchRequestSchema.parse({ run_id: RUN_UUID, top_n: 101 })).toThrow();
  });

  it('rejects a non-integer top_n', () => {
    expect(() => finalizeMatchRequestSchema.parse({ run_id: RUN_UUID, top_n: 12.5 })).toThrow();
  });

  it('rejects excluded with non-UUID candidate_id', () => {
    expect(() =>
      finalizeMatchRequestSchema.parse({
        run_id: RUN_UUID,
        excluded: [{ candidate_id: 'nope', missing_must_have_skill_ids: [SKILL_UUID] }],
      }),
    ).toThrow();
  });

  it('rejects excluded with non-UUID skill ids', () => {
    expect(() =>
      finalizeMatchRequestSchema.parse({
        run_id: RUN_UUID,
        excluded: [{ candidate_id: CAND_UUID, missing_must_have_skill_ids: ['nope'] }],
      }),
    ).toThrow();
  });

  it('strips unknown top-level keys', () => {
    const parsed = finalizeMatchRequestSchema.parse({
      run_id: RUN_UUID,
      extra: 'ignored',
    } as unknown);
    expect(parsed).not.toHaveProperty('extra');
  });
});
