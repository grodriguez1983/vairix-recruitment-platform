/**
 * Unit tests for `finalizeMatchRun` (ADR-034 §3).
 *
 * Closes a running match_run. The FE calls this once after the
 * `/process-chunk` loop ends. Per ADR-034 + migration 004 (Option 1),
 * the persisted `match_results.rank` is chunk-local and reads order
 * by `total_score DESC` — there is NO global re-rank step here.
 *
 * Pipeline:
 *   loadRunForFinalize(runId) →
 *   loadTopResults(runId, topN) → loadFailedResults(runId) →
 *   rescueFailedCandidates? (orthogonal — errors swallowed) →
 *   completeMatchRun(runId, { finished_at, candidates_evaluated,
 *                              diagnostics })
 *
 * Response: `{ candidates_evaluated, top: CandidateScore[],
 *              rescues_inserted? }`
 *   - `candidates_evaluated` = `match_runs.processed_count` (the
 *     authoritative counter advanced by /process-chunk; no second
 *     COUNT(*) needed).
 *   - `rescues_inserted` present iff `rescueFailedCandidates` was
 *     wired (matches the legacy `runMatchJob` semantics).
 *
 * On any failure other than rescue: rethrow; the run STAYS `running`
 * so the FE can retry /finalize. ADR-034 model: backend is dumb, FE
 * owns the lifecycle. No failMatchRun side-effect from here.
 *
 * Adversarial focus: terminal guard, rescue merge, rescue-error
 * isolation, response shape, dep ordering, processed_count as the
 * source of truth for candidates_evaluated.
 */
import { describe, expect, it, vi } from 'vitest';

import { finalizeMatchRun } from './finalize-match-run';
import type {
  FinalizeMatchRunDeps,
  FinalizeMatchRunInput,
  LoadedMatchRunForFinalize,
  TopMatchResultRow,
} from './finalize-match-run';
import type { PreFilterExcludedCandidate } from './pre-filter';
import type { FailedCandidateInput } from './run-match-job';

const NOW = new Date('2025-02-01T12:00:00Z');

function mkLoadedRun(
  overrides: Partial<LoadedMatchRunForFinalize> = {},
): LoadedMatchRunForFinalize {
  return {
    status: 'running',
    expected_count: 100,
    processed_count: 87,
    tenant_id: null,
    ...overrides,
  };
}

function topRow(id: string, total: number, rank: number): TopMatchResultRow {
  return {
    candidate_id: id,
    total_score: total,
    must_have_gate: 'passed',
    rank,
    breakdown_json: {
      breakdown: [],
      language_match: { required: 0, matched: 0 },
      seniority_match: 'unknown',
    },
  };
}

function mkDeps(overrides: Partial<FinalizeMatchRunDeps> = {}): FinalizeMatchRunDeps {
  return {
    loadRunForFinalize: vi.fn(async () => mkLoadedRun()),
    loadTopResults: vi.fn(async (_id: string, n: number) =>
      Array.from({ length: Math.min(n, 3) }, (_, i) => topRow(`top-${i + 1}`, 1 - i * 0.1, i + 1)),
    ),
    loadFailedResults: vi.fn(async (): Promise<FailedCandidateInput[]> => []),
    completeMatchRun: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

const VALID_INPUT: FinalizeMatchRunInput = {
  runId: 'run-1',
  topN: 10,
  excluded: [],
};

describe('finalizeMatchRun (ADR-034 §3)', () => {
  it('happy path: returns { candidates_evaluated, top, rescues_inserted? }', async () => {
    const deps = mkDeps();
    const result = await finalizeMatchRun(VALID_INPUT, deps);
    expect(result.candidates_evaluated).toBe(87); // = run.processed_count
    expect(result.top).toHaveLength(3);
    expect(result.top.map((t) => t.candidate_id)).toEqual(['top-1', 'top-2', 'top-3']);
    // No rescue dep wired → no rescues_inserted in response.
    expect(result.rescues_inserted).toBeUndefined();
  });

  it('omits rescues_inserted when rescueFailedCandidates is not wired', async () => {
    const deps = mkDeps();
    const result = await finalizeMatchRun(VALID_INPUT, deps);
    expect(result).not.toHaveProperty('rescues_inserted');
  });

  it('throws if loadRunForFinalize returns null AND does no other work', async () => {
    const loadTopResults = vi.fn(async (): Promise<TopMatchResultRow[]> => []);
    const loadFailedResults = vi.fn(async (): Promise<FailedCandidateInput[]> => []);
    const completeMatchRun = vi.fn(async () => {});
    const deps = mkDeps({
      loadRunForFinalize: vi.fn(async () => null),
      loadTopResults,
      loadFailedResults,
      completeMatchRun,
    });
    await expect(finalizeMatchRun(VALID_INPUT, deps)).rejects.toThrow(/match_run not found/i);
    expect(loadTopResults).not.toHaveBeenCalled();
    expect(loadFailedResults).not.toHaveBeenCalled();
    expect(completeMatchRun).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'abandoned'] as const)(
    'throws if run is in terminal status %s and does no other work',
    async (terminalStatus) => {
      const loadTopResults = vi.fn(async (): Promise<TopMatchResultRow[]> => []);
      const completeMatchRun = vi.fn(async () => {});
      const deps = mkDeps({
        loadRunForFinalize: vi.fn(async () => mkLoadedRun({ status: terminalStatus })),
        loadTopResults,
        completeMatchRun,
      });
      await expect(finalizeMatchRun(VALID_INPUT, deps)).rejects.toThrow(/not running/i);
      expect(loadTopResults).not.toHaveBeenCalled();
      expect(completeMatchRun).not.toHaveBeenCalled();
    },
  );

  it('preserves dep ordering: loadRun → loadTop → loadFailed → rescue → complete', async () => {
    const calls: string[] = [];
    const deps = mkDeps({
      loadRunForFinalize: vi.fn(async () => {
        calls.push('loadRunForFinalize');
        return mkLoadedRun();
      }),
      loadTopResults: vi.fn(async (_id: string, n: number) => {
        calls.push('loadTopResults');
        return [topRow('top-1', 0.9, 1)].slice(0, n);
      }),
      loadFailedResults: vi.fn(async (): Promise<FailedCandidateInput[]> => {
        calls.push('loadFailedResults');
        return [{ candidate_id: 'cF', missing_skill_ids: ['s1'] }];
      }),
      rescueFailedCandidates: vi.fn(async () => {
        calls.push('rescueFailedCandidates');
        return { rescues_inserted: 1 };
      }),
      completeMatchRun: vi.fn(async () => {
        calls.push('completeMatchRun');
      }),
    });
    await finalizeMatchRun(VALID_INPUT, deps);
    expect(calls).toEqual([
      'loadRunForFinalize',
      'loadTopResults',
      'loadFailedResults',
      'rescueFailedCandidates',
      'completeMatchRun',
    ]);
  });

  it('forwards topN to loadTopResults', async () => {
    const loadTopResults = vi.fn(async (): Promise<TopMatchResultRow[]> => []);
    const deps = mkDeps({ loadTopResults });
    await finalizeMatchRun({ ...VALID_INPUT, topN: 25 }, deps);
    expect(loadTopResults).toHaveBeenCalledWith('run-1', 25);
  });

  it('candidates_evaluated comes from match_runs.processed_count, NOT from top.length', async () => {
    // processed_count and top length should be independent — the
    // top is a windowed read, processed_count is the run-wide
    // counter advanced by /process-chunk. The response must report
    // the counter, not the window.
    const deps = mkDeps({
      loadRunForFinalize: vi.fn(async () => mkLoadedRun({ processed_count: 5_487 })),
      loadTopResults: vi.fn(async () => [topRow('top-1', 0.9, 1)]),
    });
    const result = await finalizeMatchRun({ ...VALID_INPUT, topN: 10 }, deps);
    expect(result.candidates_evaluated).toBe(5_487);
    expect(result.top).toHaveLength(1);
  });

  it('reconstructs CandidateScore from breakdown_json on top rows', async () => {
    const langMatch = { required: 2, matched: 1 };
    const deps = mkDeps({
      loadTopResults: vi.fn(
        async (): Promise<TopMatchResultRow[]> => [
          {
            candidate_id: 'cA',
            total_score: 0.91,
            must_have_gate: 'passed',
            rank: 7, // chunk-local rank — irrelevant to the response shape
            breakdown_json: {
              breakdown: [{ stub: true }],
              language_match: langMatch,
              seniority_match: 'above',
            },
          },
        ],
      ),
    });
    const result = await finalizeMatchRun(VALID_INPUT, deps);
    expect(result.top).toEqual([
      {
        candidate_id: 'cA',
        total_score: 0.91,
        must_have_gate: 'passed',
        breakdown: [{ stub: true }],
        language_match: langMatch,
        seniority_match: 'above',
      },
    ]);
  });

  it('merges failed + excluded into rescue input (excluded with empty missing skips)', async () => {
    type RescueDep = NonNullable<FinalizeMatchRunDeps['rescueFailedCandidates']>;
    const rescueFailedCandidates = vi.fn<RescueDep>(async () => ({ rescues_inserted: 0 }));
    const excluded: PreFilterExcludedCandidate[] = [
      { candidate_id: 'cE1', missing_must_have_skill_ids: ['s9'] },
      { candidate_id: 'cE2', missing_must_have_skill_ids: [] }, // skipped
      { candidate_id: 'cF1', missing_must_have_skill_ids: ['s2'] }, // dup of failed → skipped
    ];
    const deps = mkDeps({
      loadFailedResults: vi.fn(
        async (): Promise<FailedCandidateInput[]> => [
          { candidate_id: 'cF1', missing_skill_ids: ['s1', 's2'] },
        ],
      ),
      rescueFailedCandidates,
    });
    await finalizeMatchRun({ ...VALID_INPUT, excluded }, deps);
    expect(rescueFailedCandidates).toHaveBeenCalledTimes(1);
    const firstCall = rescueFailedCandidates.mock.calls[0];
    expect(firstCall).toBeDefined();
    const payload = firstCall![0];
    expect(payload.run_id).toBe('run-1');
    expect(payload.tenant_id).toBeNull();
    expect(payload.failed).toEqual([
      { candidate_id: 'cF1', missing_skill_ids: ['s1', 's2'] }, // failed wins on dup
      { candidate_id: 'cE1', missing_skill_ids: ['s9'] },
    ]);
  });

  it('skips rescueFailedCandidates entirely when there is no rescue work', async () => {
    const rescueFailedCandidates = vi.fn(async () => ({ rescues_inserted: 0 }));
    const deps = mkDeps({
      loadFailedResults: vi.fn(async () => []),
      rescueFailedCandidates,
    });
    const result = await finalizeMatchRun({ ...VALID_INPUT, excluded: [] }, deps);
    expect(rescueFailedCandidates).not.toHaveBeenCalled();
    // The dep was wired, so the field is present (0) — the caller
    // can distinguish "no rescue dep" (undefined) from "rescue dep
    // present, nothing to rescue" (0). Same shape as runMatchJob.
    expect(result.rescues_inserted).toBe(0);
  });

  it('rescue errors are SWALLOWED (orthogonal to ranking) — run still completes', async () => {
    const completeMatchRun = vi.fn(async () => {});
    const rescueFailedCandidates = vi.fn(async () => {
      throw new Error('rescue: flaky FTS');
    });
    const deps = mkDeps({
      loadFailedResults: vi.fn(async () => [{ candidate_id: 'cF', missing_skill_ids: ['s1'] }]),
      rescueFailedCandidates,
      completeMatchRun,
    });
    const result = await finalizeMatchRun(VALID_INPUT, deps);
    expect(completeMatchRun).toHaveBeenCalledTimes(1);
    expect(result.rescues_inserted).toBe(0);
  });

  it('completeMatchRun receives finished_at = deps.now() and candidates_evaluated = processed_count', async () => {
    const completeMatchRun = vi.fn(async () => {});
    const customNow = new Date('2030-06-15T03:14:15Z');
    const deps = mkDeps({
      loadRunForFinalize: vi.fn(async () => mkLoadedRun({ processed_count: 42 })),
      completeMatchRun,
      now: () => customNow,
    });
    await finalizeMatchRun(VALID_INPUT, deps);
    expect(completeMatchRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        finished_at: customNow,
        candidates_evaluated: 42,
      }),
    );
  });

  it('on loadTopResults failure: rethrows; no rescue, no complete (run stays running for retry)', async () => {
    const rescueFailedCandidates = vi.fn(async () => ({ rescues_inserted: 0 }));
    const completeMatchRun = vi.fn(async () => {});
    const deps = mkDeps({
      loadTopResults: vi.fn(async () => {
        throw new Error('loadTopResults: pg_error');
      }),
      rescueFailedCandidates,
      completeMatchRun,
    });
    await expect(finalizeMatchRun(VALID_INPUT, deps)).rejects.toThrow(/loadTopResults: pg_error/);
    expect(rescueFailedCandidates).not.toHaveBeenCalled();
    expect(completeMatchRun).not.toHaveBeenCalled();
  });

  it('on completeMatchRun failure: rethrows (run stays running, FE retries finalize)', async () => {
    const deps = mkDeps({
      completeMatchRun: vi.fn(async () => {
        throw new Error('completeMatchRun: pg_error');
      }),
    });
    await expect(finalizeMatchRun(VALID_INPUT, deps)).rejects.toThrow(/completeMatchRun: pg_error/);
  });
});
