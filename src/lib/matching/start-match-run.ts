/**
 * `startMatchRun` — ADR-034 §1.
 *
 * Opens a `match_run` and returns the plan the FE needs to drive the
 * chunk loop:
 *
 *   loadJobQuery → createMatchRun (status='running') →
 *   preFilter → setExpectedCount (= included.length) →
 *   return { run_id, included, excluded, total, tenant_id }
 *
 * STUB — this file is the RED-cycle scaffold so the test file
 * type-checks. Real implementation lands in the GREEN commit.
 */
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import type { PreFilterByMustHaveResult } from './pre-filter';

export interface StartMatchRunInput {
  jobQueryId: string;
  triggeredBy: string;
}

export interface LoadedJobQuery {
  resolved: ResolvedDecomposition;
  catalog_snapshot_at: Date;
  tenant_id: string | null;
}

export interface CreateMatchRunArgs {
  job_query_id: string;
  tenant_id: string | null;
  triggered_by: string;
  catalog_snapshot_at: Date;
}

export interface FailMatchRunArgs {
  finished_at: Date;
  reason: string;
}

export interface StartMatchRunDeps {
  loadJobQuery: (jobQueryId: string) => Promise<LoadedJobQuery | null>;
  createMatchRun: (args: CreateMatchRunArgs) => Promise<{ id: string }>;
  preFilter: (
    resolved: ResolvedDecomposition,
    tenantId: string | null,
  ) => Promise<PreFilterByMustHaveResult>;
  setExpectedCount: (runId: string, expectedCount: number) => Promise<void>;
  failMatchRun: (runId: string, args: FailMatchRunArgs) => Promise<void>;
  now: () => Date;
}

export interface StartMatchRunResult {
  run_id: string;
  included: string[];
  excluded: PreFilterByMustHaveResult['excluded'];
  total: number;
  tenant_id: string | null;
}

export async function startMatchRun(
  _input: StartMatchRunInput,
  _deps: StartMatchRunDeps,
): Promise<StartMatchRunResult> {
  // RED stub — intentionally wrong so adversarial tests fail.
  throw new Error('startMatchRun: not implemented');
}
