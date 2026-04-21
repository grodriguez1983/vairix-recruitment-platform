/**
 * Unit tests for `runMatchJob` (F4-008 sub-C).
 *
 * Orchestrator service that composes the matching pipeline:
 *
 *   loadJobQuery → createMatchRun (status=running) →
 *   preFilter → loadCandidates → rank → insertMatchResults →
 *   completeMatchRun
 *
 * On any failure the run is closed with status='failed' and the
 * error is rethrown. The state-machine trigger on match_runs
 * enforces that the row goes running → (completed|failed); this
 * orchestrator is its client.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import { runMatchJob } from './run-match-job';
import type { MatchResultRow, RunMatchJobDeps, RunMatchJobInput } from './run-match-job';
import type { CandidateAggregate, CandidateScore, RankResult, RequirementBreakdown } from './types';

const REACT_ID = '00000000-0000-0000-0000-000000000001';
const SNAPSHOT = new Date('2025-01-01T00:00:00Z');
const NOW = new Date('2025-02-01T12:00:00Z');

function jobQuery(): ResolvedDecomposition {
  return {
    requirements: [
      {
        skill_raw: 'React',
        skill_id: REACT_ID,
        resolved_at: '2025-01-01T00:00:00Z',
        min_years: 1,
        max_years: null,
        must_have: false,
        evidence_snippet: 'React',
        category: 'technical',
      },
    ],
    seniority: 'unspecified',
    languages: [],
    notes: null,
  };
}

function mkRequirementBreakdown(
  skillId: string | null,
  skillRaw: string,
  mustHave: boolean,
  status: 'match' | 'partial' | 'missing',
): RequirementBreakdown {
  return {
    requirement: {
      skill_raw: skillRaw,
      skill_id: skillId,
      resolved_at: skillId === null ? null : '2025-01-01T00:00:00Z',
      min_years: 1,
      max_years: null,
      must_have: mustHave,
      evidence_snippet: skillRaw,
      category: 'technical',
    },
    candidate_years: status === 'match' ? 5 : 0,
    years_ratio: status === 'match' ? 1 : 0,
    contribution: 0,
    status,
    evidence: [],
  };
}

function mkScore(candidateId: string, totalScore: number, rank = 0): CandidateScore {
  return {
    candidate_id: candidateId,
    total_score: totalScore,
    must_have_gate: totalScore === 0 ? 'failed' : 'passed',
    breakdown: [],
    language_match: { required: 0, matched: 0 },
    seniority_match: 'unknown',
    // note: rank is NOT part of CandidateScore — added when persisting.
    ...(rank === 0 ? {} : {}),
  };
}

function mkDeps(overrides: Partial<RunMatchJobDeps> = {}): RunMatchJobDeps {
  return {
    loadJobQuery: vi.fn(async () => ({
      resolved: jobQuery(),
      catalog_snapshot_at: SNAPSHOT,
      tenant_id: null,
    })),
    preFilter: vi.fn(async () => ({ included: ['c1', 'c2'], excluded: [] })),
    loadCandidates: vi.fn(
      async (ids: string[]): Promise<CandidateAggregate[]> =>
        ids.map((id) => ({ candidate_id: id, merged_experiences: [], languages: [] })),
    ),
    rank: vi.fn(
      async (): Promise<RankResult> => ({
        results: [mkScore('c1', 80), mkScore('c2', 60)],
        diagnostics: [{ candidate_id: 'c2', warning: 'low-overlap' }],
      }),
    ),
    createMatchRun: vi.fn(async () => ({ id: 'run-1' })),
    insertMatchResults: vi.fn(async () => undefined),
    completeMatchRun: vi.fn(async () => undefined),
    failMatchRun: vi.fn(async () => undefined),
    now: () => NOW,
    ...overrides,
  };
}

function input(over: Partial<RunMatchJobInput> = {}): RunMatchJobInput {
  return {
    jobQueryId: 'jq-1',
    topN: 10,
    triggeredBy: 'user-1',
    ...over,
  };
}

describe('runMatchJob — F4-008 sub-C', () => {
  it('happy path: creates run → pre-filter → load → rank → insert → complete', async () => {
    const deps = mkDeps();
    const out = await runMatchJob(input(), deps);

    expect(deps.loadJobQuery).toHaveBeenCalledWith('jq-1');
    expect(deps.createMatchRun).toHaveBeenCalledWith({
      job_query_id: 'jq-1',
      tenant_id: null,
      triggered_by: 'user-1',
      catalog_snapshot_at: SNAPSHOT,
    });
    expect(deps.preFilter).toHaveBeenCalledWith(expect.any(Object), null);
    expect(deps.loadCandidates).toHaveBeenCalledWith(['c1', 'c2']);
    expect(deps.rank).toHaveBeenCalledWith({
      jobQuery: expect.any(Object),
      candidates: expect.any(Array),
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(deps.insertMatchResults).toHaveBeenCalledTimes(1);
    expect(deps.completeMatchRun).toHaveBeenCalledWith('run-1', {
      finished_at: NOW,
      candidates_evaluated: 2,
      diagnostics: [{ candidate_id: 'c2', warning: 'low-overlap' }],
    });
    expect(deps.failMatchRun).not.toHaveBeenCalled();

    expect(out.run_id).toBe('run-1');
    expect(out.candidates_evaluated).toBe(2);
    expect(out.top).toHaveLength(2);
    expect(out.top.map((t) => t.candidate_id)).toEqual(['c1', 'c2']);
  });

  it('inserts all results with sequential rank (1..N) and tenant_id', async () => {
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => ({
        resolved: jobQuery(),
        catalog_snapshot_at: SNAPSHOT,
        tenant_id: 't-42',
      })),
      rank: vi.fn(async () => ({
        results: [mkScore('a', 90), mkScore('b', 80), mkScore('c', 70)],
        diagnostics: [],
      })),
    });
    await runMatchJob(input(), deps);

    const call = (deps.insertMatchResults as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [runId, rows] = call;
    expect(runId).toBe('run-1');
    const typed = rows as MatchResultRow[];
    expect(typed.map((r) => r.rank)).toEqual([1, 2, 3]);
    expect(typed.map((r) => r.candidate_id)).toEqual(['a', 'b', 'c']);
    expect(typed.every((r) => r.tenant_id === 't-42')).toBe(true);
    expect(typed[0]!.total_score).toBe(90);
    expect(typed[0]!.must_have_gate).toBe('passed');
  });

  it('breakdown_json persisted is the aggregator output per candidate', async () => {
    const score = mkScore('c1', 42);
    score.breakdown = [];
    score.language_match = { required: 2, matched: 1 };
    const deps = mkDeps({
      rank: vi.fn(async () => ({ results: [score], diagnostics: [] })),
    });
    await runMatchJob(input(), deps);
    const call = (deps.insertMatchResults as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [, rows] = call;
    const typed = rows as MatchResultRow[];
    expect(typed[0]!.breakdown_json).toEqual({
      breakdown: [],
      language_match: { required: 2, matched: 1 },
      seniority_match: 'unknown',
    });
  });

  it('respects topN for the returned slice (all results still persisted)', async () => {
    const deps = mkDeps({
      rank: vi.fn(async () => ({
        results: [
          mkScore('a', 90),
          mkScore('b', 80),
          mkScore('c', 70),
          mkScore('d', 60),
          mkScore('e', 50),
        ],
        diagnostics: [],
      })),
    });
    const out = await runMatchJob(input({ topN: 3 }), deps);
    expect(out.top.map((t) => t.candidate_id)).toEqual(['a', 'b', 'c']);
    const call = (deps.insertMatchResults as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [, rows] = call;
    expect((rows as MatchResultRow[]).length).toBe(5);
    expect(out.candidates_evaluated).toBe(5);
  });

  it('job_query not found → throws and does NOT create a run', async () => {
    const deps = mkDeps({ loadJobQuery: vi.fn(async () => null) });
    await expect(runMatchJob(input(), deps)).rejects.toThrow(/job_query/i);
    expect(deps.createMatchRun).not.toHaveBeenCalled();
    expect(deps.failMatchRun).not.toHaveBeenCalled();
  });

  it('rank throws → failMatchRun called with reason, error rethrown', async () => {
    const boom = new Error('ranker exploded');
    const deps = mkDeps({
      rank: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(runMatchJob(input(), deps)).rejects.toThrow('ranker exploded');
    expect(deps.failMatchRun).toHaveBeenCalledWith('run-1', {
      finished_at: NOW,
      reason: 'ranker exploded',
    });
    expect(deps.completeMatchRun).not.toHaveBeenCalled();
  });

  it('insertMatchResults throws → failMatchRun called, error rethrown', async () => {
    const boom = new Error('insert failed');
    const deps = mkDeps({
      insertMatchResults: vi.fn(async () => {
        throw boom;
      }),
    });
    await expect(runMatchJob(input(), deps)).rejects.toThrow('insert failed');
    expect(deps.failMatchRun).toHaveBeenCalledWith('run-1', {
      finished_at: NOW,
      reason: 'insert failed',
    });
    expect(deps.completeMatchRun).not.toHaveBeenCalled();
  });

  it('empty candidate pool → completes run with 0, skips insertMatchResults', async () => {
    const deps = mkDeps({
      preFilter: vi.fn(async () => ({ included: [], excluded: [] })),
      loadCandidates: vi.fn(async () => []),
      rank: vi.fn(async () => ({ results: [], diagnostics: [] })),
    });
    const out = await runMatchJob(input(), deps);
    expect(deps.insertMatchResults).not.toHaveBeenCalled();
    expect(deps.completeMatchRun).toHaveBeenCalledWith('run-1', {
      finished_at: NOW,
      candidates_evaluated: 0,
      diagnostics: [],
    });
    expect(out.top).toEqual([]);
    expect(out.candidates_evaluated).toBe(0);
  });

  it('invokes rescueFailedCandidates with gate-failed candidates + their missing must-have skill IDs (ADR-016 §1)', async () => {
    const REACT = '10000000-0000-0000-0000-000000000001';
    const PG = '10000000-0000-0000-0000-000000000002';
    const TS = '10000000-0000-0000-0000-000000000003';
    const AWS = '10000000-0000-0000-0000-000000000004';
    const failedScore: CandidateScore = {
      candidate_id: 'c-fail',
      total_score: 10,
      must_have_gate: 'failed',
      breakdown: [
        mkRequirementBreakdown(REACT, 'React', true, 'missing'),
        mkRequirementBreakdown(PG, 'Postgres', true, 'partial'),
        mkRequirementBreakdown(TS, 'TypeScript', true, 'match'),
        mkRequirementBreakdown(AWS, 'AWS', false, 'missing'),
        mkRequirementBreakdown(null, 'Unresolved', true, 'missing'), // excluded (null id)
      ],
      language_match: { required: 0, matched: 0 },
      seniority_match: 'unknown',
    };
    const passedScore = mkScore('c-pass', 90);
    const rescueHook = vi.fn(async () => ({ rescues_inserted: 1 }));
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => ({
        resolved: jobQuery(),
        catalog_snapshot_at: SNAPSHOT,
        tenant_id: 't-rescue',
      })),
      rank: vi.fn(async () => ({ results: [passedScore, failedScore], diagnostics: [] })),
      rescueFailedCandidates: rescueHook,
    });

    const out = await runMatchJob(input(), deps);

    expect(rescueHook).toHaveBeenCalledTimes(1);
    expect(rescueHook).toHaveBeenCalledWith({
      run_id: 'run-1',
      tenant_id: 't-rescue',
      failed: [
        {
          candidate_id: 'c-fail',
          missing_skill_ids: [REACT, PG], // must_have && status !== 'match' && skill_id !== null
        },
      ],
    });
    expect(out.rescues_inserted).toBe(1);
  });

  it('skips rescueFailedCandidates when no candidate fails the must-have gate', async () => {
    const rescueHook = vi.fn(async () => ({ rescues_inserted: 0 }));
    const deps = mkDeps({
      rank: vi.fn(async () => ({
        results: [mkScore('c1', 80), mkScore('c2', 70)],
        diagnostics: [],
      })),
      rescueFailedCandidates: rescueHook,
    });
    const out = await runMatchJob(input(), deps);
    expect(rescueHook).not.toHaveBeenCalled();
    expect(out.rescues_inserted).toBe(0);
  });

  it('omits rescues_inserted when the rescue dep is not wired (backwards compat)', async () => {
    const deps = mkDeps(); // no rescueFailedCandidates
    const out = await runMatchJob(input(), deps);
    expect(out.rescues_inserted).toBeUndefined();
  });

  it('rescueFailedCandidates throws → run still completes (swallowed, rescues_inserted=0)', async () => {
    const failedScore: CandidateScore = {
      candidate_id: 'c-fail',
      total_score: 0,
      must_have_gate: 'failed',
      breakdown: [
        mkRequirementBreakdown('10000000-0000-0000-0000-000000000099', 'React', true, 'missing'),
      ],
      language_match: { required: 0, matched: 0 },
      seniority_match: 'unknown',
    };
    const rescueHook = vi.fn(async () => {
      throw new Error('FTS exploded');
    });
    const deps = mkDeps({
      rank: vi.fn(async () => ({ results: [failedScore], diagnostics: [] })),
      rescueFailedCandidates: rescueHook,
    });
    // Run should not throw — rescue is orthogonal per ADR-016.
    const out = await runMatchJob(input(), deps);
    expect(deps.completeMatchRun).toHaveBeenCalled();
    expect(deps.failMatchRun).not.toHaveBeenCalled();
    expect(out.rescues_inserted).toBe(0);
  });

  it('propagates tenant_id from job_query to every write path', async () => {
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => ({
        resolved: jobQuery(),
        catalog_snapshot_at: SNAPSHOT,
        tenant_id: 'tenant-xyz',
      })),
    });
    await runMatchJob(input(), deps);
    expect(deps.createMatchRun).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-xyz' }),
    );
    expect(deps.preFilter).toHaveBeenCalledWith(expect.any(Object), 'tenant-xyz');
    const call = (deps.insertMatchResults as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [, rows] = call;
    expect((rows as MatchResultRow[]).every((r) => r.tenant_id === 'tenant-xyz')).toBe(true);
  });
});
