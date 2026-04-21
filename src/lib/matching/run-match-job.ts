/**
 * `runMatchJob` — F4-008 sub-C orchestrator service.
 *
 * Composes the matching pipeline behind a single entrypoint:
 *
 *   loadJobQuery → createMatchRun (status=running) →
 *   preFilter → loadCandidates → rank → insertMatchResults →
 *   completeMatchRun
 *
 * On any failure after `createMatchRun`, `failMatchRun` stamps the
 * run and the error is rethrown. The `match_runs` state-machine
 * trigger (migration 20260420000006) enforces the running →
 * (completed|failed) transition.
 *
 * All I/O is injected so the unit suite doesn't need Supabase; sub-D
 * wires the real DB clients + API route.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import type { CandidateAggregate, CandidateScore, RankResult, RankerInput } from './types';

export interface MatchResultRow {
  candidate_id: string;
  tenant_id: string | null;
  total_score: number;
  must_have_gate: 'passed' | 'failed';
  rank: number;
  breakdown_json: unknown;
}

export interface RunMatchJobInput {
  jobQueryId: string;
  topN: number;
  triggeredBy: string | null;
}

export interface RunMatchJobResult {
  run_id: string;
  candidates_evaluated: number;
  top: CandidateScore[];
}

export interface RunMatchJobDeps {
  loadJobQuery: (jobQueryId: string) => Promise<{
    resolved: ResolvedDecomposition;
    catalog_snapshot_at: Date;
    tenant_id: string | null;
  } | null>;
  preFilter: (jobQuery: ResolvedDecomposition, tenantId: string | null) => Promise<string[]>;
  loadCandidates: (candidateIds: string[]) => Promise<CandidateAggregate[]>;
  rank: (input: RankerInput) => Promise<RankResult>;
  createMatchRun: (params: {
    job_query_id: string;
    tenant_id: string | null;
    triggered_by: string | null;
    catalog_snapshot_at: Date;
  }) => Promise<{ id: string }>;
  insertMatchResults: (runId: string, rows: MatchResultRow[]) => Promise<void>;
  completeMatchRun: (
    runId: string,
    params: {
      finished_at: Date;
      candidates_evaluated: number;
      diagnostics: unknown;
    },
  ) => Promise<void>;
  failMatchRun: (runId: string, params: { finished_at: Date; reason: string }) => Promise<void>;
  now?: () => Date;
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

export async function runMatchJob(
  input: RunMatchJobInput,
  deps: RunMatchJobDeps,
): Promise<RunMatchJobResult> {
  const now = deps.now ?? ((): Date => new Date());

  const jq = await deps.loadJobQuery(input.jobQueryId);
  if (jq === null) {
    throw new Error(`runMatchJob: job_query not found: ${input.jobQueryId}`);
  }
  const { resolved, catalog_snapshot_at, tenant_id } = jq;

  const { id: runId } = await deps.createMatchRun({
    job_query_id: input.jobQueryId,
    tenant_id,
    triggered_by: input.triggeredBy,
    catalog_snapshot_at,
  });

  try {
    const candidateIds = await deps.preFilter(resolved, tenant_id);
    const aggregates = await deps.loadCandidates(candidateIds);
    const rankResult = await deps.rank({
      jobQuery: resolved,
      candidates: aggregates,
      catalogSnapshotAt: catalog_snapshot_at,
    });

    if (rankResult.results.length > 0) {
      const rows = rankResult.results.map((score, i) => toMatchResultRow(score, tenant_id, i + 1));
      await deps.insertMatchResults(runId, rows);
    }

    await deps.completeMatchRun(runId, {
      finished_at: now(),
      candidates_evaluated: rankResult.results.length,
      diagnostics: rankResult.diagnostics,
    });

    return {
      run_id: runId,
      candidates_evaluated: rankResult.results.length,
      top: rankResult.results.slice(0, input.topN),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.failMatchRun(runId, { finished_at: now(), reason });
    throw err;
  }
}
