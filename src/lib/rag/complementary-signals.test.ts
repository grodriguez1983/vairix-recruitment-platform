/**
 * Unit tests for `complementary-signals` (ADR-016 §1 — FTS recall-fallback).
 *
 * Pure service: consumes gate-failed candidates with their missing
 * must-have skill slugs, queries FTS over `files.parsed_text`, and
 * emits rescue rows suitable for `match_rescues` insert.
 *
 * Key invariants under test:
 *   1. Threshold filtering: only hits with `ts_rank > FTS_RESCUE_THRESHOLD`
 *      survive. Exactly-equal is excluded (strict > by ADR-016 §1).
 *   2. A rescue row exists iff the candidate has AT LEAST ONE surviving
 *      hit across their missing skills.
 *   3. `fts_snippets` is grouped by skill_slug. Only skills with surviving
 *      hits appear as keys.
 *   4. `missing_skills` is the full input list (not just those that
 *      matched) — so the UI can show "missing React; evidence found".
 *   5. `fts_max_rank` = max ts_rank across surviving hits for that candidate.
 *   6. No FTS call when the input list is empty or every candidate has
 *      no missing skills.
 *   7. Deterministic: same input → same output, snippets ordered
 *      descending by ts_rank then ascending by snippet text.
 */
import { describe, expect, it, vi } from 'vitest';

import {
  FTS_RESCUE_THRESHOLD,
  fetchFtsRescues,
  type ComplementarySignalsDeps,
  type FtsHit,
  type FtsRescueCandidate,
  type RescueRow,
} from './complementary-signals';

function makeDeps(hits: FtsHit[]): {
  deps: ComplementarySignalsDeps;
  queryFts: ReturnType<typeof vi.fn>;
} {
  const queryFts = vi.fn(async () => hits);
  return { deps: { queryFts }, queryFts };
}

describe('fetchFtsRescues — ADR-016 §1', () => {
  it('returns empty array when there are no candidates', async () => {
    const { deps, queryFts } = makeDeps([]);
    const result = await fetchFtsRescues([], deps);
    expect(result).toEqual([]);
    expect(queryFts).not.toHaveBeenCalled();
  });

  it('returns empty array when every candidate has zero missing skills', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: [] },
      { candidate_id: 'c2', missing_skill_slugs: [] },
    ];
    const { deps, queryFts } = makeDeps([]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(result).toEqual([]);
    expect(queryFts).not.toHaveBeenCalled();
  });

  it('drops candidates whose hits all fall at or below the threshold', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: ['react'] },
    ];
    const { deps } = makeDeps([
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: FTS_RESCUE_THRESHOLD, snippet: 'weak' },
      {
        candidate_id: 'c1',
        skill_slug: 'react',
        ts_rank: FTS_RESCUE_THRESHOLD - 0.01,
        snippet: 'weaker',
      },
    ]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(result).toEqual([]);
  });

  it('keeps only hits strictly above the threshold and groups snippets by skill', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: ['react', 'postgres'] },
    ];
    const { deps } = makeDeps([
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.4, snippet: 'used React daily' },
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.05, snippet: 'weak' }, // dropped
      { candidate_id: 'c1', skill_slug: 'postgres', ts_rank: 0.25, snippet: 'postgres DBA' },
    ]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(result).toHaveLength(1);
    expect(result[0]!.candidate_id).toBe('c1');
    expect(result[0]!.missing_skills).toEqual(['react', 'postgres']);
    expect(result[0]!.fts_snippets).toEqual({
      react: ['used React daily'],
      postgres: ['postgres DBA'],
    });
    expect(result[0]!.fts_max_rank).toBeCloseTo(0.4, 4);
  });

  it('keeps candidates with at least one surviving skill (partial rescue)', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: ['react', 'kubernetes'] },
    ];
    const { deps } = makeDeps([
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.3, snippet: 'React' },
      // kubernetes has no hit above threshold
      { candidate_id: 'c1', skill_slug: 'kubernetes', ts_rank: 0.02, snippet: 'k8s?' },
    ]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(result).toHaveLength(1);
    expect(result[0]!.missing_skills).toEqual(['react', 'kubernetes']);
    expect(Object.keys(result[0]!.fts_snippets)).toEqual(['react']);
  });

  it('orders snippets per skill by ts_rank descending (then by snippet asc)', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: ['react'] },
    ];
    const { deps } = makeDeps([
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.2, snippet: 'b-mid' },
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.5, snippet: 'c-strong' },
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.2, snippet: 'a-mid' },
    ]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(result[0]!.fts_snippets['react']).toEqual(['c-strong', 'a-mid', 'b-mid']);
  });

  it('produces one row per candidate (deterministic order by candidate_id)', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c-z', missing_skill_slugs: ['react'] },
      { candidate_id: 'c-a', missing_skill_slugs: ['react'] },
    ];
    const { deps } = makeDeps([
      { candidate_id: 'c-a', skill_slug: 'react', ts_rank: 0.3, snippet: 'A react' },
      { candidate_id: 'c-z', skill_slug: 'react', ts_rank: 0.4, snippet: 'Z react' },
    ]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(result.map((r: RescueRow) => r.candidate_id)).toEqual(['c-a', 'c-z']);
  });

  it('calls queryFts with the union of missing skill slugs and candidate ids', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: ['react', 'postgres'] },
      { candidate_id: 'c2', missing_skill_slugs: ['react', 'kubernetes'] },
      { candidate_id: 'c3', missing_skill_slugs: [] }, // excluded from query
    ];
    const { deps, queryFts } = makeDeps([]);
    await fetchFtsRescues(candidates, deps);
    expect(queryFts).toHaveBeenCalledTimes(1);
    const call = queryFts.mock.calls[0]![0] as {
      candidateIds: string[];
      skillSlugs: string[];
    };
    expect(new Set(call.candidateIds)).toEqual(new Set(['c1', 'c2']));
    expect(new Set(call.skillSlugs)).toEqual(new Set(['react', 'postgres', 'kubernetes']));
  });

  it('ignores FTS hits that refer to a skill not in the candidate missing_skills list', async () => {
    const candidates: FtsRescueCandidate[] = [
      { candidate_id: 'c1', missing_skill_slugs: ['react'] },
    ];
    const { deps } = makeDeps([
      { candidate_id: 'c1', skill_slug: 'react', ts_rank: 0.3, snippet: 'react ok' },
      // postgres is not a missing skill for c1 — must be ignored even though above threshold
      { candidate_id: 'c1', skill_slug: 'postgres', ts_rank: 0.9, snippet: 'postgres noise' },
    ]);
    const result = await fetchFtsRescues(candidates, deps);
    expect(Object.keys(result[0]!.fts_snippets)).toEqual(['react']);
  });
});
