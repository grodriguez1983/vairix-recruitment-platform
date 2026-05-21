/**
 * `finalizeMatchRun` — ADR-034 §3.
 *
 * Closes a running match_run after the FE has finished its
 * /process-chunk loop. Per ADR-034 + migration 004 (Option 1), there
 * is NO global re-rank: persisted `match_results.rank` stays
 * chunk-local and reads order by `total_score DESC` via the
 * `idx_match_results_run_score` index.
 *
 * Pipeline:
 *   loadRunForFinalize → loadTopResults → loadFailedResults →
 *   rescueFailedCandidates? (orthogonal, errors swallowed) →
 *   completeMatchRun
 *
 * Response: `{ candidates_evaluated, top, rescues_inserted? }`.
 * `candidates_evaluated` is sourced from `match_runs.processed_count`
 * (the counter advanced by /process-chunk), not from a separate
 * COUNT(*). The optional `rescues_inserted` is present iff the
 * rescue dep was wired — matches the legacy `runMatchJob` semantics.
 *
 * STUB — RED-cycle scaffold. The real body lands in the GREEN commit.
 */
import type { PreFilterExcludedCandidate } from './pre-filter';
import type { MatchRunStatus } from './process-match-chunk';
import type { FailedCandidateInput } from './run-match-job';
import type { CandidateScore } from './types';

export interface LoadedMatchRunForFinalize {
  status: MatchRunStatus;
  expected_count: number | null;
  processed_count: number;
  tenant_id: string | null;
}

/** One match_results row plucked from the top-N read. The
 *  `breakdown_json` carries `{breakdown, language_match,
 *  seniority_match}` — finalizeMatchRun re-hydrates `CandidateScore`
 *  from it for the response. */
export interface TopMatchResultRow {
  candidate_id: string;
  total_score: number;
  must_have_gate: 'passed' | 'failed';
  rank: number;
  breakdown_json: unknown;
}

export interface FinalizeMatchRunInput {
  runId: string;
  topN: number;
  excluded: PreFilterExcludedCandidate[];
}

export interface FinalizeMatchRunResult {
  candidates_evaluated: number;
  top: CandidateScore[];
  /** Present iff the rescue dep was wired. 0 means rescue ran but
   *  nothing landed (no failed candidates, or rescue swallowed). */
  rescues_inserted?: number;
}

export interface FinalizeMatchRunDeps {
  loadRunForFinalize: (runId: string) => Promise<LoadedMatchRunForFinalize | null>;
  loadTopResults: (runId: string, topN: number) => Promise<TopMatchResultRow[]>;
  /** Returns one row per gate-failed candidate, shaped as the
   *  rescue input — adapter handles the `breakdown_json` → missing
   *  skill_ids derivation so the service stays out of the
   *  breakdown shape. */
  loadFailedResults: (runId: string) => Promise<FailedCandidateInput[]>;
  rescueFailedCandidates?: (params: {
    run_id: string;
    tenant_id: string | null;
    failed: FailedCandidateInput[];
  }) => Promise<{ rescues_inserted: number }>;
  completeMatchRun: (
    runId: string,
    params: {
      finished_at: Date;
      candidates_evaluated: number;
      diagnostics: unknown;
    },
  ) => Promise<void>;
  now: () => Date;
}

export async function finalizeMatchRun(
  _input: FinalizeMatchRunInput,
  _deps: FinalizeMatchRunDeps,
): Promise<FinalizeMatchRunResult> {
  // RED stub.
  throw new Error('finalizeMatchRun: not implemented');
}
