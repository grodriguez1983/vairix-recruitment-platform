/**
 * `processMatchChunk` — ADR-034 §2.
 *
 * Workhorse of the FE-driven chunked matching pipeline. The FE calls
 * this N times with slices of the `included` pool returned by
 * `/start`. Per chunk:
 *
 *   loadRunForChunk(runId) → loadCandidates(chunk) →
 *   rank(chunk) → insertMatchResults (chunk-local rank 1..N) →
 *   bumpProgress(runId, chunk.length)
 *
 * Invariants:
 *   - Guarded by status: only a 'running' run accepts chunks.
 *   - `match_results.rank` persisted here is CHUNK-LOCAL. Reads go
 *     via `(match_run_id, total_score desc)` (migration 004). The
 *     global re-rank happens in `/finalize`.
 *   - `processed_count` advances by `candidateIds.length`, not by
 *     `rank.results.length` — dropped candidates were still
 *     "processed". The bump only fires AFTER a successful insert so
 *     a retry doesn't double-count.
 *   - Empty chunks are a no-op (no I/O after loadRunForChunk).
 *   - The post-bump `processed_count` returned by `bumpProgress` is
 *     what the FE sees, so a concurrent writer's increment is
 *     observed truthfully.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import type { MatchResultRow } from './run-match-job';
import type { CandidateAggregate, CandidateScore, RankResult, RankerInput } from './types';

export type MatchRunStatus = 'running' | 'completed' | 'failed' | 'abandoned';

export interface LoadedMatchRunForChunk {
  status: MatchRunStatus;
  expected_count: number | null;
  processed_count: number;
  tenant_id: string | null;
  job_query_id: string;
  resolved: ResolvedDecomposition;
  catalog_snapshot_at: Date;
}

export interface ProcessMatchChunkInput {
  runId: string;
  candidateIds: string[];
}

export interface ProcessMatchChunkResult {
  processed_count: number;
  total: number | null;
  new_results: CandidateScore[];
}

export interface ProcessMatchChunkDeps {
  loadRunForChunk: (runId: string) => Promise<LoadedMatchRunForChunk | null>;
  loadCandidates: (candidateIds: string[]) => Promise<CandidateAggregate[]>;
  rank: (input: RankerInput) => Promise<RankResult>;
  insertMatchResults: (runId: string, rows: MatchResultRow[]) => Promise<void>;
  /**
   * Atomically increments `match_runs.processed_count` by `delta`
   * and stamps `last_progress_at = now()`. Returns the post-bump
   * `processed_count` so the FE sees the authoritative value even
   * if a concurrent writer raced.
   */
  bumpProgress: (runId: string, delta: number) => Promise<{ processed_count: number }>;
  now: () => Date;
}

function toMatchResultRow(
  score: CandidateScore,
  tenantId: string | null,
  rank: number,
): MatchResultRow {
  return {
    candidate_id: score.candidate_id,
    tenant_id: tenantId,
    total_score: score.total_score,
    must_have_gate: score.must_have_gate,
    rank,
    breakdown_json: {
      breakdown: score.breakdown,
      language_match: score.language_match,
      seniority_match: score.seniority_match,
    },
  };
}

export async function processMatchChunk(
  input: ProcessMatchChunkInput,
  deps: ProcessMatchChunkDeps,
): Promise<ProcessMatchChunkResult> {
  const run = await deps.loadRunForChunk(input.runId);
  if (run === null) {
    throw new Error(`match_run not found: ${input.runId}`);
  }
  if (run.status !== 'running') {
    throw new Error(`match_run ${input.runId} is not running (status=${run.status})`);
  }

  // Empty chunk — short-circuit; nothing changed.
  if (input.candidateIds.length === 0) {
    return {
      processed_count: run.processed_count,
      total: run.expected_count,
      new_results: [],
    };
  }

  const aggregates = await deps.loadCandidates(input.candidateIds);
  const rankResult = await deps.rank({
    jobQuery: run.resolved,
    candidates: aggregates,
    catalogSnapshotAt: run.catalog_snapshot_at,
  });

  if (rankResult.results.length > 0) {
    const rows = rankResult.results.map((score, i) =>
      toMatchResultRow(score, run.tenant_id, i + 1),
    );
    await deps.insertMatchResults(input.runId, rows);
  }

  const { processed_count } = await deps.bumpProgress(input.runId, input.candidateIds.length);

  return {
    processed_count,
    total: run.expected_count,
    new_results: rankResult.results,
  };
}
