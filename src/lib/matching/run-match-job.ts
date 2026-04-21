/**
 * `runMatchJob` — F4-008 sub-C orchestrator service (RED stub).
 *
 * Composes the matching pipeline behind a single entrypoint. All I/O
 * is injected so the unit suite doesn't need Supabase; sub-D wires
 * the real DB clients + API route.
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

export async function runMatchJob(
  _input: RunMatchJobInput,
  _deps: RunMatchJobDeps,
): Promise<RunMatchJobResult> {
  throw new Error('runMatchJob: not implemented (F4-008 sub-C RED)');
}
