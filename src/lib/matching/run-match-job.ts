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

import type { PreFilterByMustHaveResult, PreFilterExcludedCandidate } from './pre-filter';
import type {
  CandidateAggregate,
  CandidateScore,
  RankResult,
  RankerInput,
  RequirementBreakdown,
} from './types';

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
  /** Set iff `rescueFailedCandidates` dep was wired. 0 means invoked
   *  but nothing landed (no failed candidates, or rescue swallowed). */
  rescues_inserted?: number;
}

export interface FailedCandidateInput {
  candidate_id: string;
  /** Must-have, unresolved-excluded, status !== 'match'. */
  missing_skill_ids: string[];
}

export interface RunMatchJobDeps {
  loadJobQuery: (jobQueryId: string) => Promise<{
    resolved: ResolvedDecomposition;
    catalog_snapshot_at: Date;
    tenant_id: string | null;
  } | null>;
  preFilter: (
    jobQuery: ResolvedDecomposition,
    tenantId: string | null,
  ) => Promise<PreFilterByMustHaveResult>;
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
  /**
   * Optional post-run rescue hook (ADR-016 §1). Invoked after
   * `completeMatchRun` with the gate-failed candidates + their
   * missing must-have skill ids. Errors are swallowed (the rescue
   * bucket is orthogonal to the official ranking).
   */
  rescueFailedCandidates?: (params: {
    run_id: string;
    tenant_id: string | null;
    failed: FailedCandidateInput[];
  }) => Promise<{ rescues_inserted: number }>;
  now?: () => Date;
}

/**
 * Pluck the resolved must-have skill_ids from the breakdown that
 * belong to FAILED groups — a group is "satisfied" iff at least one
 * alternative has status === 'match'. Per ADR-021, rescue only
 * needs to re-check the groups that actually failed.
 */
function collectFailedCandidates(results: CandidateScore[]): FailedCandidateInput[] {
  const out: FailedCandidateInput[] = [];
  for (const score of results) {
    if (score.must_have_gate !== 'failed') continue;

    // Bucket must-have rows with a resolved skill_id by group. A
    // null alternative_group_id means the row is its own singleton
    // group; we synthesize unique keys so siblings do not collide.
    interface GroupBucket {
      skillIds: string[];
      satisfied: boolean;
    }
    const buckets = new Map<string, GroupBucket>();
    let singletonIdx = 0;
    for (const b of score.breakdown as RequirementBreakdown[]) {
      if (!b.requirement.must_have) continue;
      if (b.requirement.skill_id === null) continue;
      const key =
        b.requirement.alternative_group_id === null
          ? `__singleton_${singletonIdx++}`
          : `g:${b.requirement.alternative_group_id}`;
      const existing = buckets.get(key);
      const isMatch = b.status === 'match';
      if (existing) {
        existing.skillIds.push(b.requirement.skill_id);
        if (isMatch) existing.satisfied = true;
      } else {
        buckets.set(key, { skillIds: [b.requirement.skill_id], satisfied: isMatch });
      }
    }

    const missing: string[] = [];
    for (const bucket of buckets.values()) {
      if (bucket.satisfied) continue;
      for (const s of bucket.skillIds) missing.push(s);
    }
    if (missing.length === 0) continue;
    out.push({ candidate_id: score.candidate_id, missing_skill_ids: missing });
  }
  return out;
}

/**
 * Merges gate-failed candidates from the ranker with the pre-filter
 * excluded pool. The two sets are disjoint by construction (excluded
 * candidates never reach the ranker) so no dedup is required, but we
 * guard for it defensively anyway.
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
    const preFilterResult = await deps.preFilter(resolved, tenant_id);
    const aggregates = await deps.loadCandidates(preFilterResult.included);
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

    // Post-run rescue (ADR-016 §1). Orthogonal to the ranking —
    // errors are swallowed so a flaky FTS never fails the run.
    // F4-008 ter: also rescue the pre-filter excluded pool, which
    // never reached the ranker but may have the missing must-have
    // in files.parsed_text.
    let rescuesInserted: number | undefined;
    if (deps.rescueFailedCandidates !== undefined) {
      rescuesInserted = 0;
      const gateFailed = collectFailedCandidates(rankResult.results);
      const failed = mergeRescueInputs(gateFailed, preFilterResult.excluded);
      if (failed.length > 0) {
        try {
          const r = await deps.rescueFailedCandidates({
            run_id: runId,
            tenant_id,
            failed,
          });
          rescuesInserted = r.rescues_inserted;
        } catch {
          // Swallow — rescue bucket failure must not fail a completed run.
        }
      }
    }

    return {
      run_id: runId,
      candidates_evaluated: rankResult.results.length,
      top: rankResult.results.slice(0, input.topN),
      ...(rescuesInserted !== undefined ? { rescues_inserted: rescuesInserted } : {}),
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    await deps.failMatchRun(runId, { finished_at: now(), reason });
    throw err;
  }
}
