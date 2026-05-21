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
 * Error model: rethrow on anything other than rescue. The run stays
 * `running` so the FE can retry /finalize — backend is dumb, FE owns
 * the lifecycle (ADR-034). Rescue is orthogonal to ranking
 * (ADR-016 §1) so its errors are swallowed and rescues_inserted
 * degrades to 0.
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

/**
 * Re-hydrates a `CandidateScore` from a persisted `match_results`
 * row. `breakdown_json` carries `{breakdown, language_match,
 * seniority_match}`; the chunk-local `rank` is dropped — the
 * response shape doesn't expose it.
 */
function rowToCandidateScore(row: TopMatchResultRow): CandidateScore {
  const bj = row.breakdown_json as {
    breakdown: CandidateScore['breakdown'];
    language_match: CandidateScore['language_match'];
    seniority_match: CandidateScore['seniority_match'];
  };
  return {
    candidate_id: row.candidate_id,
    total_score: row.total_score,
    must_have_gate: row.must_have_gate,
    breakdown: bj.breakdown,
    language_match: bj.language_match,
    seniority_match: bj.seniority_match,
  };
}

/**
 * Merge gate-failed candidates with the pre-filter excluded pool.
 * Failed wins on duplicate `candidate_id`; excluded rows with no
 * `missing_must_have_skill_ids` are dropped (nothing to FTS-check).
 * Parity with `runMatchJob.mergeRescueInputs`.
 */
function mergeRescueInputs(
  gateFailed: FailedCandidateInput[],
  preFilterExcluded: PreFilterExcludedCandidate[],
): FailedCandidateInput[] {
  const byCandidate = new Map<string, FailedCandidateInput>();
  for (const gf of gateFailed) {
    byCandidate.set(gf.candidate_id, gf);
  }
  for (const pe of preFilterExcluded) {
    if (pe.missing_must_have_skill_ids.length === 0) continue;
    if (byCandidate.has(pe.candidate_id)) continue;
    byCandidate.set(pe.candidate_id, {
      candidate_id: pe.candidate_id,
      missing_skill_ids: pe.missing_must_have_skill_ids,
    });
  }
  return Array.from(byCandidate.values());
}

export async function finalizeMatchRun(
  input: FinalizeMatchRunInput,
  deps: FinalizeMatchRunDeps,
): Promise<FinalizeMatchRunResult> {
  const run = await deps.loadRunForFinalize(input.runId);
  if (run === null) {
    throw new Error(`match_run not found: ${input.runId}`);
  }
  if (run.status !== 'running') {
    throw new Error(`match_run ${input.runId} is not running (status=${run.status})`);
  }

  const topRows = await deps.loadTopResults(input.runId, input.topN);
  const failed = await deps.loadFailedResults(input.runId);

  // Rescue (orthogonal, ADR-016 §1). `rescues_inserted` stays
  // undefined when the dep is not wired — same surface as runMatchJob.
  let rescuesInserted: number | undefined;
  if (deps.rescueFailedCandidates !== undefined) {
    rescuesInserted = 0;
    const merged = mergeRescueInputs(failed, input.excluded);
    if (merged.length > 0) {
      try {
        const r = await deps.rescueFailedCandidates({
          run_id: input.runId,
          tenant_id: run.tenant_id,
          failed: merged,
        });
        rescuesInserted = r.rescues_inserted;
      } catch {
        // Swallow — rescue must not fail a completable run.
      }
    }
  }

  await deps.completeMatchRun(input.runId, {
    finished_at: deps.now(),
    candidates_evaluated: run.processed_count,
    diagnostics: {},
  });

  return {
    candidates_evaluated: run.processed_count,
    top: topRows.map(rowToCandidateScore),
    ...(rescuesInserted !== undefined ? { rescues_inserted: rescuesInserted } : {}),
  };
}
