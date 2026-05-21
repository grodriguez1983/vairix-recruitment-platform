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
 * STUB — RED-cycle scaffold. The real body lands in the GREEN commit.
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

export async function processMatchChunk(
  _input: ProcessMatchChunkInput,
  _deps: ProcessMatchChunkDeps,
): Promise<ProcessMatchChunkResult> {
  // RED stub.
  throw new Error('processMatchChunk: not implemented');
}
