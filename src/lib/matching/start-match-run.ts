/**
 * `startMatchRun` — ADR-034 §1 + ADR-035.
 *
 * Opens a `match_run` and returns the plan the FE needs to drive the
 * chunk loop:
 *
 *   loadJobQuery → [validate override] → createMatchRun →
 *   persistEffectiveResolved → preFilter → setExpectedCount →
 *   return { run_id, included, excluded, total, tenant_id }
 *
 * On any failure AFTER `createMatchRun`, the run is closed via
 * `failMatchRun(reason)` and the error is rethrown so the route
 * handler can surface it. On `loadJobQuery` returning null (no such
 * job), the service throws WITHOUT creating a run — nothing to fail.
 *
 * Override (ADR-035): when `resolvedOverride` is present, the service
 * checks the subset rule against `loaded.resolved` BEFORE creating
 * the run, so an invalid override never produces a `match_runs` row.
 * If valid, the override is what gets snapshotted and fed to
 * preFilter; downstream chunks read the snapshot, not
 * `job_queries.resolved_json`.
 *
 * All I/O is injected (`StartMatchRunDeps`) so the route handler can
 * compose db adapters and tests can wire `vi.fn` mocks.
 */
import type {
  ResolvedDecomposition,
  ResolvedRequirement,
} from '../rag/decomposition/resolve-requirements';

import type { PreFilterByMustHaveResult } from './pre-filter';

export interface StartMatchRunInput {
  jobQueryId: string;
  triggeredBy: string;
  /**
   * ADR-035: recruiter-edited subset of the LLM's resolved
   * decomposition. When present, validated against `loaded.resolved`
   * (subset rule) and used in place of it for preFilter and the
   * snapshot. When absent, `loaded.resolved` is used unchanged.
   */
  resolvedOverride?: ResolvedDecomposition;
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
  /**
   * ADR-035: seal the effective `ResolvedDecomposition` onto the
   * `match_runs` row immediately after creation, before any heavy
   * work runs. This way a crash mid-preFilter still leaves an
   * auditable snapshot of what was about to be ranked.
   */
  persistEffectiveResolved: (runId: string, resolved: ResolvedDecomposition) => Promise<void>;
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

  // ADR-035: validate override before opening the run, so an invalid
  // override never produces a `match_runs` row that has to be failed.
  if (input.resolvedOverride !== undefined) {
    const issue = validateOverrideIsSubset(loaded.resolved, input.resolvedOverride);
    if (issue !== null) {
      throw new Error(`invalid_override: ${issue}`);
    }
  }
  const effective = input.resolvedOverride ?? loaded.resolved;

  const { id: runId } = await deps.createMatchRun({
    job_query_id: input.jobQueryId,
    tenant_id: loaded.tenant_id,
    triggered_by: input.triggeredBy,
    catalog_snapshot_at: loaded.catalog_snapshot_at,
  });

  try {
    // Seal the effective resolved BEFORE any heavy work, so a crash
    // mid-preFilter still leaves an auditable record (ADR-035).
    await deps.persistEffectiveResolved(runId, effective);
    const preFilterResult = await deps.preFilter(effective, loaded.tenant_id);
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

/**
 * Pure subset check for the recruiter override (ADR-035).
 *
 * The override is admissible iff:
 *   - `seniority`, `languages`, `notes`, `role_essentials` match the
 *     original exactly (out of scope for editing in this pass).
 *   - every override requirement maps to a unique original requirement
 *     by identity tuple (skill_id, alternative_group_id, category,
 *     skill_raw, evidence_snippet). Only `must_have`, `min_years`,
 *     `max_years` may differ.
 *   - override may omit requirements (delete is allowed); it MUST NOT
 *     introduce a requirement absent from the original.
 *
 * Returns `null` when valid, or a string describing the first
 * violation (used as the error message for `/start` to surface).
 *
 * Exported for unit testing; not part of the runtime surface of
 * `startMatchRun` callers.
 */
export function validateOverrideIsSubset(
  original: ResolvedDecomposition,
  override: ResolvedDecomposition,
): string | null {
  if (override.seniority !== original.seniority) {
    return `seniority changed (${original.seniority} → ${override.seniority})`;
  }
  if (override.notes !== original.notes) {
    return 'notes changed';
  }
  if (!deepEqualJson(override.languages, original.languages)) {
    return 'languages changed';
  }
  if (!deepEqualJson(override.role_essentials, original.role_essentials)) {
    return 'role_essentials changed';
  }

  // Match override requirements to originals by identity. Each
  // original can match at most one override entry — duplicates in the
  // override would otherwise let a recruiter "split" a requirement.
  const originalAvailable = original.requirements.map(() => true);
  for (const ovReq of override.requirements) {
    const idx = original.requirements.findIndex(
      (or, i) => originalAvailable[i] && sameRequirementIdentity(or, ovReq),
    );
    if (idx === -1) {
      return `requirement '${ovReq.skill_raw}' (skill_id=${ovReq.skill_id ?? 'null'}) not in original`;
    }
    originalAvailable[idx] = false;
  }
  return null;
}

function sameRequirementIdentity(a: ResolvedRequirement, b: ResolvedRequirement): boolean {
  return (
    a.skill_id === b.skill_id &&
    a.alternative_group_id === b.alternative_group_id &&
    a.category === b.category &&
    a.skill_raw === b.skill_raw &&
    a.evidence_snippet === b.evidence_snippet
  );
}

/** Tiny JSON-stable deep equal for the read-only sub-structures we
 *  compare (languages array, role_essentials array). Both shapes are
 *  plain objects/arrays of primitives, so JSON.stringify is safe. */
function deepEqualJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}
