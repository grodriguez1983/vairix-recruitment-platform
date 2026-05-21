/**
 * Unit tests for `processMatchChunk` (ADR-034 §2).
 *
 * `processMatchChunk` is the workhorse of the FE-driven chunked
 * pipeline. The FE calls it N times with slices of the `included`
 * pool it received from `/start`. Per chunk:
 *
 *   loadRunForChunk(runId) → loadCandidates(chunk) →
 *   rank(chunk) → insertMatchResults (chunk-local rank 1..N) →
 *   bumpProgress(runId, chunk.length)
 *
 * Response: `{ processed_count, total, new_results }`
 *   - `processed_count` is the POST-bump value (returned by the dep).
 *   - `total` is `match_runs.expected_count` (null-safe).
 *   - `new_results` is the rank output for the chunk.
 *
 * Adversarial focus:
 *   - Terminal-status guard (no work against a closed run).
 *   - Chunk-local rank — `rank` field is 1..N inside the chunk, not
 *     global (ADR-034 swapped index to total_score; finalize re-ranks).
 *   - bumpProgress increments by `candidateIds.length` (not by
 *     rank.results.length), and ONLY after a successful insert.
 *   - Empty chunk: short-circuit cleanly (no insert, no bump).
 *
 * Integration coverage lives in tests/integration/matching/.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import { processMatchChunk } from './process-match-chunk';
import type {
  LoadedMatchRunForChunk,
  ProcessMatchChunkDeps,
  ProcessMatchChunkInput,
} from './process-match-chunk';
import type { MatchResultRow } from './run-match-job';
import type { CandidateAggregate, CandidateScore, RankResult, RankerInput } from './types';

const SNAPSHOT = new Date('2025-01-01T00:00:00Z');
const NOW = new Date('2025-02-01T12:00:00Z');

function jobQuery(): ResolvedDecomposition {
  return {
    requirements: [],
    seniority: 'unspecified',
    languages: [],
    notes: null,
    role_essentials: [],
  };
}

function aggregate(id: string): CandidateAggregate {
  return {
    candidate_id: id,
    merged_experiences: [],
    languages: [],
  };
}

function score(id: string, total: number, gate: 'passed' | 'failed' = 'passed'): CandidateScore {
  return {
    candidate_id: id,
    total_score: total,
    must_have_gate: gate,
    breakdown: [],
    language_match: { required: 0, matched: 0 },
    seniority_match: 'unknown',
  };
}

function mkLoadedRun(overrides: Partial<LoadedMatchRunForChunk> = {}): LoadedMatchRunForChunk {
  return {
    status: 'running',
    expected_count: 100,
    processed_count: 0,
    tenant_id: null,
    job_query_id: 'jq-1',
    resolved: jobQuery(),
    catalog_snapshot_at: SNAPSHOT,
    ...overrides,
  };
}

function mkDeps(overrides: Partial<ProcessMatchChunkDeps> = {}): ProcessMatchChunkDeps {
  return {
    loadRunForChunk: vi.fn(async () => mkLoadedRun()),
    loadCandidates: vi.fn(async (ids: string[]) => ids.map(aggregate)),
    rank: vi.fn(
      async (input: RankerInput): Promise<RankResult> => ({
        results: input.candidates.map((c, i) => score(c.candidate_id, 1 - i * 0.1)),
        diagnostics: {} as never,
      }),
    ),
    insertMatchResults: vi.fn(async () => {}),
    bumpProgress: vi.fn(async (_id: string, delta: number) => ({ processed_count: delta })),
    now: () => NOW,
    ...overrides,
  };
}

const VALID_INPUT: ProcessMatchChunkInput = {
  runId: 'run-1',
  candidateIds: ['c1', 'c2', 'c3'],
};

describe('processMatchChunk (ADR-034)', () => {
  it('happy path: returns { processed_count, total, new_results }', async () => {
    const deps = mkDeps();
    const result = await processMatchChunk(VALID_INPUT, deps);
    expect(result.processed_count).toBe(3);
    expect(result.total).toBe(100);
    expect(result.new_results).toHaveLength(3);
    expect(result.new_results.map((r) => r.candidate_id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('throws if loadRunForChunk returns null AND does no work', async () => {
    const loadCandidates = vi.fn(async (ids: string[]) => ids.map(aggregate));
    const insertMatchResults = vi.fn(async () => {});
    const bumpProgress = vi.fn(async () => ({ processed_count: 0 }));
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () => null),
      loadCandidates,
      insertMatchResults,
      bumpProgress,
    });
    await expect(processMatchChunk(VALID_INPUT, deps)).rejects.toThrow(/match_run not found/i);
    expect(loadCandidates).not.toHaveBeenCalled();
    expect(insertMatchResults).not.toHaveBeenCalled();
    expect(bumpProgress).not.toHaveBeenCalled();
  });

  it.each(['completed', 'failed', 'abandoned'] as const)(
    'throws if run is in terminal status %s and does no work',
    async (terminalStatus) => {
      const insertMatchResults = vi.fn(async () => {});
      const bumpProgress = vi.fn(async () => ({ processed_count: 0 }));
      const deps = mkDeps({
        loadRunForChunk: vi.fn(async () => mkLoadedRun({ status: terminalStatus })),
        insertMatchResults,
        bumpProgress,
      });
      await expect(processMatchChunk(VALID_INPUT, deps)).rejects.toThrow(/not running/i);
      expect(insertMatchResults).not.toHaveBeenCalled();
      expect(bumpProgress).not.toHaveBeenCalled();
    },
  );

  it('empty candidate_ids: no insert, no bump, returns processed_count from run', async () => {
    const loadCandidates = vi.fn(async (ids: string[]) => ids.map(aggregate));
    const insertMatchResults = vi.fn(async () => {});
    const bumpProgress = vi.fn(async () => ({ processed_count: 999 }));
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () => mkLoadedRun({ processed_count: 42 })),
      loadCandidates,
      insertMatchResults,
      bumpProgress,
    });
    const result = await processMatchChunk({ runId: 'run-1', candidateIds: [] }, deps);
    expect(loadCandidates).not.toHaveBeenCalled();
    expect(insertMatchResults).not.toHaveBeenCalled();
    expect(bumpProgress).not.toHaveBeenCalled();
    expect(result.processed_count).toBe(42);
    expect(result.new_results).toEqual([]);
  });

  it('forwards resolved + catalog_snapshot_at + aggregates to rank', async () => {
    const resolved = jobQuery();
    const rank = vi.fn(
      async (input: RankerInput): Promise<RankResult> => ({
        results: input.candidates.map((c) => score(c.candidate_id, 0.5)),
        diagnostics: {} as never,
      }),
    );
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () =>
        mkLoadedRun({ resolved, catalog_snapshot_at: SNAPSHOT, tenant_id: 'tenant-xyz' }),
      ),
      rank,
    });
    await processMatchChunk(VALID_INPUT, deps);
    expect(rank).toHaveBeenCalledTimes(1);
    const call = rank.mock.calls[0]?.[0] as RankerInput;
    expect(call.jobQuery).toBe(resolved);
    expect(call.catalogSnapshotAt).toBe(SNAPSHOT);
    expect(call.candidates.map((c) => c.candidate_id)).toEqual(['c1', 'c2', 'c3']);
  });

  it('persists chunk-local rank 1..N (NOT global)', async () => {
    const insertMatchResults = vi.fn<(runId: string, rows: MatchResultRow[]) => Promise<void>>(
      async () => {},
    );
    const deps = mkDeps({
      // Five-row chunk, descending scores. The persisted rank should
      // be 1..5 within the chunk, not whatever global position they
      // would hold across the whole run.
      rank: vi.fn(
        async (): Promise<RankResult> => ({
          results: [
            score('cA', 0.9),
            score('cB', 0.8),
            score('cC', 0.7),
            score('cD', 0.6),
            score('cE', 0.5),
          ],
          diagnostics: {} as never,
        }),
      ),
      insertMatchResults,
    });
    await processMatchChunk({ runId: 'run-1', candidateIds: ['cA', 'cB', 'cC', 'cD', 'cE'] }, deps);
    expect(insertMatchResults).toHaveBeenCalledTimes(1);
    const firstCall = insertMatchResults.mock.calls[0];
    expect(firstCall).toBeDefined();
    const rows = firstCall![1];
    expect(rows.map((r) => ({ id: r.candidate_id, rank: r.rank }))).toEqual([
      { id: 'cA', rank: 1 },
      { id: 'cB', rank: 2 },
      { id: 'cC', rank: 3 },
      { id: 'cD', rank: 4 },
      { id: 'cE', rank: 5 },
    ]);
  });

  it('stamps tenant_id on every inserted row (from the loaded run)', async () => {
    const insertMatchResults = vi.fn<(runId: string, rows: MatchResultRow[]) => Promise<void>>(
      async () => {},
    );
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () => mkLoadedRun({ tenant_id: 'tenant-xyz' })),
      insertMatchResults,
    });
    await processMatchChunk(VALID_INPUT, deps);
    const firstCall = insertMatchResults.mock.calls[0];
    expect(firstCall).toBeDefined();
    const rows = firstCall![1];
    expect(rows.every((r) => r.tenant_id === 'tenant-xyz')).toBe(true);
  });

  it('skips insert when rank returns 0 results but STILL bumps progress', async () => {
    // E.g. rank dropped everything (no resolved requirements + nothing
    // to score). The candidates were still "processed" — they passed
    // through the pipeline — so processed_count must advance.
    const insertMatchResults = vi.fn(async () => {});
    const bumpProgress = vi.fn(async () => ({ processed_count: 3 }));
    const deps = mkDeps({
      rank: vi.fn(async (): Promise<RankResult> => ({ results: [], diagnostics: {} as never })),
      insertMatchResults,
      bumpProgress,
    });
    const result = await processMatchChunk(VALID_INPUT, deps);
    expect(insertMatchResults).not.toHaveBeenCalled();
    expect(bumpProgress).toHaveBeenCalledTimes(1);
    expect(bumpProgress).toHaveBeenCalledWith('run-1', 3);
    expect(result.new_results).toEqual([]);
    expect(result.processed_count).toBe(3);
  });

  it('preserves dep ordering: loadRunForChunk → loadCandidates → rank → insertMatchResults → bumpProgress', async () => {
    const calls: string[] = [];
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () => {
        calls.push('loadRunForChunk');
        return mkLoadedRun();
      }),
      loadCandidates: vi.fn(async (ids: string[]) => {
        calls.push('loadCandidates');
        return ids.map(aggregate);
      }),
      rank: vi.fn(async (input: RankerInput): Promise<RankResult> => {
        calls.push('rank');
        return {
          results: input.candidates.map((c) => score(c.candidate_id, 0.5)),
          diagnostics: {} as never,
        };
      }),
      insertMatchResults: vi.fn(async () => {
        calls.push('insertMatchResults');
      }),
      bumpProgress: vi.fn(async () => {
        calls.push('bumpProgress');
        return { processed_count: 3 };
      }),
    });
    await processMatchChunk(VALID_INPUT, deps);
    expect(calls).toEqual([
      'loadRunForChunk',
      'loadCandidates',
      'rank',
      'insertMatchResults',
      'bumpProgress',
    ]);
  });

  it('on loadCandidates failure, does NOT insert and does NOT bump progress', async () => {
    const insertMatchResults = vi.fn(async () => {});
    const bumpProgress = vi.fn(async () => ({ processed_count: 0 }));
    const deps = mkDeps({
      loadCandidates: vi.fn(async () => {
        throw new Error('loadCandidates: simulated timeout');
      }),
      insertMatchResults,
      bumpProgress,
    });
    await expect(processMatchChunk(VALID_INPUT, deps)).rejects.toThrow(
      /loadCandidates: simulated timeout/,
    );
    expect(insertMatchResults).not.toHaveBeenCalled();
    expect(bumpProgress).not.toHaveBeenCalled();
  });

  it('on rank failure, does NOT insert and does NOT bump progress', async () => {
    const insertMatchResults = vi.fn(async () => {});
    const bumpProgress = vi.fn(async () => ({ processed_count: 0 }));
    const deps = mkDeps({
      rank: vi.fn(async () => {
        throw new Error('rank: boom');
      }),
      insertMatchResults,
      bumpProgress,
    });
    await expect(processMatchChunk(VALID_INPUT, deps)).rejects.toThrow(/rank: boom/);
    expect(insertMatchResults).not.toHaveBeenCalled();
    expect(bumpProgress).not.toHaveBeenCalled();
  });

  it('on insertMatchResults failure, does NOT bump progress (prevents double-count on retry)', async () => {
    const bumpProgress = vi.fn(async () => ({ processed_count: 0 }));
    const deps = mkDeps({
      insertMatchResults: vi.fn(async () => {
        throw new Error('insertMatchResults: pg_error');
      }),
      bumpProgress,
    });
    await expect(processMatchChunk(VALID_INPUT, deps)).rejects.toThrow(
      /insertMatchResults: pg_error/,
    );
    expect(bumpProgress).not.toHaveBeenCalled();
  });

  it('returns the processed_count from bumpProgress (post-bump value, not chunk size)', async () => {
    // bumpProgress is what reads the row back; we trust whatever it
    // says, not our local arithmetic, in case other writers raced.
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () => mkLoadedRun({ processed_count: 1000 })),
      bumpProgress: vi.fn(async () => ({ processed_count: 1003 })),
    });
    const result = await processMatchChunk(VALID_INPUT, deps);
    expect(result.processed_count).toBe(1003);
  });

  it('returns total = expected_count (null-safe when expected_count is null)', async () => {
    const deps = mkDeps({
      loadRunForChunk: vi.fn(async () => mkLoadedRun({ expected_count: null })),
    });
    const result = await processMatchChunk(VALID_INPUT, deps);
    expect(result.total).toBeNull();
  });

  it('bumps progress by candidateIds.length (NOT by rank.results.length)', async () => {
    // Candidates that the ranker drops are still "processed".
    const bumpProgress = vi.fn(async (_id: string, delta: number) => ({ processed_count: delta }));
    const deps = mkDeps({
      rank: vi.fn(
        async (): Promise<RankResult> => ({
          results: [score('c1', 0.9)], // only one of the three got scored
          diagnostics: {} as never,
        }),
      ),
      bumpProgress,
    });
    await processMatchChunk(VALID_INPUT, deps);
    expect(bumpProgress).toHaveBeenCalledWith('run-1', 3); // chunk size, not 1
  });
});
