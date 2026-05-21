/**
 * Adversarial tests for the POST /api/matching/run/process-chunk
 * request schema (ADR-034 §2).
 *
 * Focus on inputs that MUST NOT reach the service:
 *   - missing run_id / candidate_ids
 *   - non-UUID values
 *   - chunk over the 500-id cap (ADR-032 — keeps a single insert
 *     batch under PostgREST body cap)
 *   - extra unknown top-level fields (stripped, not errored)
 */
import { describe, expect, it } from 'vitest';

import { processMatchChunkRequestSchema } from './route';

const RUN_UUID = '00000000-0000-0000-0000-000000000001';
const CAND_UUID = (n: number): string =>
  `00000000-0000-0000-0000-${n.toString().padStart(12, '0')}`;

describe('processMatchChunkRequestSchema', () => {
  it('accepts a minimal well-formed request', () => {
    const parsed = processMatchChunkRequestSchema.parse({
      run_id: RUN_UUID,
      candidate_ids: [CAND_UUID(1), CAND_UUID(2)],
    });
    expect(parsed.run_id).toBe(RUN_UUID);
    expect(parsed.candidate_ids).toHaveLength(2);
  });

  it('accepts an empty candidate_ids array (chunk no-op)', () => {
    const parsed = processMatchChunkRequestSchema.parse({
      run_id: RUN_UUID,
      candidate_ids: [],
    });
    expect(parsed.candidate_ids).toEqual([]);
  });

  it('accepts the boundary chunk size (500)', () => {
    const ids = Array.from({ length: 500 }, (_, i) => CAND_UUID(i + 1));
    const parsed = processMatchChunkRequestSchema.parse({
      run_id: RUN_UUID,
      candidate_ids: ids,
    });
    expect(parsed.candidate_ids).toHaveLength(500);
  });

  it('rejects chunks larger than 500 ids', () => {
    const ids = Array.from({ length: 501 }, (_, i) => CAND_UUID(i + 1));
    expect(() =>
      processMatchChunkRequestSchema.parse({ run_id: RUN_UUID, candidate_ids: ids }),
    ).toThrow();
  });

  it('rejects a missing run_id', () => {
    expect(() => processMatchChunkRequestSchema.parse({ candidate_ids: [CAND_UUID(1)] })).toThrow();
  });

  it('rejects a missing candidate_ids', () => {
    expect(() => processMatchChunkRequestSchema.parse({ run_id: RUN_UUID })).toThrow();
  });

  it('rejects a non-UUID run_id', () => {
    expect(() =>
      processMatchChunkRequestSchema.parse({ run_id: 'not-a-uuid', candidate_ids: [] }),
    ).toThrow();
  });

  it('rejects non-UUID entries in candidate_ids', () => {
    expect(() =>
      processMatchChunkRequestSchema.parse({
        run_id: RUN_UUID,
        candidate_ids: [CAND_UUID(1), 'nope'],
      }),
    ).toThrow();
  });

  it('strips unknown top-level keys', () => {
    const parsed = processMatchChunkRequestSchema.parse({
      run_id: RUN_UUID,
      candidate_ids: [CAND_UUID(1)],
      top_n: 25,
      extra: 'ignored',
    } as unknown);
    expect(parsed).not.toHaveProperty('top_n');
    expect(parsed).not.toHaveProperty('extra');
  });
});
