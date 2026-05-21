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
 * On any failure AFTER `createMatchRun`, the run is closed via
 * `failMatchRun(reason)` and the error is rethrown so the route
 * handler can surface it. On `loadJobQuery` returning null (no such
 * job), the service throws WITHOUT creating a run — nothing to fail.
 *
 * All I/O is injected (`StartMatchRunDeps`) so the route handler can
 * compose db adapters and tests can wire `vi.fn` mocks.
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
  input: StartMatchRunInput,
  deps: StartMatchRunDeps,
): Promise<StartMatchRunResult> {
  const loaded = await deps.loadJobQuery(input.jobQueryId);
  if (loaded === null) {
    // No run was created — nothing to fail.
    throw new Error(`job_query not found: ${input.jobQueryId}`);
  }

  const { id: runId } = await deps.createMatchRun({
    job_query_id: input.jobQueryId,
    tenant_id: loaded.tenant_id,
    triggered_by: input.triggeredBy,
    catalog_snapshot_at: loaded.catalog_snapshot_at,
  });

  try {
    const preFilterResult = await deps.preFilter(loaded.resolved, loaded.tenant_id);
    await deps.setExpectedCount(runId, preFilterResult.included.length);
    return {
      run_id: runId,
      included: preFilterResult.included,
      excluded: preFilterResult.excluded,
      total: preFilterResult.included.length,
      tenant_id: loaded.tenant_id,
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.failMatchRun(runId, { finished_at: deps.now(), reason });
    throw err;
  }
}
