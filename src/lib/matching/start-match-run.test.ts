/**
 * Unit tests for `startMatchRun` (ADR-034 §1).
 *
 * `startMatchRun` opens a `match_run` and returns the plan the FE
 * needs to drive the chunk loop:
 *
 *   loadJobQuery → createMatchRun (status='running') →
 *   preFilter → setExpectedCount (= included.length) →
 *   return { run_id, included, excluded, total, tenant_id }
 *
 * On any failure AFTER `createMatchRun`, the run is closed via
 * `failMatchRun(reason)` and the error is rethrown so the route
 * handler can surface it. On `loadJobQuery` returning null (no such
 * job), the service throws WITHOUT creating a run (nothing to fail).
 *
 * Adversarial focus: dep ordering, error handling, payload shape.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import { startMatchRun } from './start-match-run';
import type { StartMatchRunDeps, StartMatchRunInput } from './start-match-run';
import type { PreFilterByMustHaveResult, PreFilterExcludedCandidate } from './pre-filter';

const SNAPSHOT = new Date('2025-01-01T00:00:00Z');
const NOW = new Date('2025-02-01T12:00:00Z');

function jobQuery(): ResolvedDecomposition {
  return {
    requirements: [],
    seniority: 'unspecified',
    languages: [],
    notes: null,
    role_essentials: [],
  };
}

function mkDeps(overrides: Partial<StartMatchRunDeps> = {}): StartMatchRunDeps {
  return {
    loadJobQuery: vi.fn(async () => ({
      resolved: jobQuery(),
      catalog_snapshot_at: SNAPSHOT,
      tenant_id: null,
    })),
    createMatchRun: vi.fn(async () => ({ id: 'run-1' })),
    preFilter: vi.fn(
      async (): Promise<PreFilterByMustHaveResult> => ({
        included: ['c1', 'c2', 'c3'],
        excluded: [],
      }),
    ),
    setExpectedCount: vi.fn(async () => {}),
    failMatchRun: vi.fn(async () => {}),
    now: () => NOW,
    ...overrides,
  };
}

const VALID_INPUT: StartMatchRunInput = {
  jobQueryId: 'jq-1',
  triggeredBy: 'app-user-1',
};

describe('startMatchRun (ADR-034)', () => {
  it('happy path: opens a run and returns { run_id, included, excluded, total }', async () => {
    const deps = mkDeps();
    const result = await startMatchRun(VALID_INPUT, deps);
    expect(result.run_id).toBe('run-1');
    expect(result.included).toEqual(['c1', 'c2', 'c3']);
    expect(result.excluded).toEqual([]);
    expect(result.total).toBe(3);
    expect(result.tenant_id).toBeNull();
  });

  it('throws if loadJobQuery returns null AND does NOT create a match_run', async () => {
    const createMatchRun = vi.fn(async () => ({ id: 'should-not-be-called' }));
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => null),
      createMatchRun,
    });
    await expect(startMatchRun(VALID_INPUT, deps)).rejects.toThrow(/job_query not found/i);
    expect(createMatchRun).not.toHaveBeenCalled();
  });

  it('forwards tenant_id, triggered_by and catalog_snapshot_at into createMatchRun', async () => {
    const createMatchRun = vi.fn(async () => ({ id: 'run-1' }));
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => ({
        resolved: jobQuery(),
        catalog_snapshot_at: SNAPSHOT,
        tenant_id: 'tenant-xyz',
      })),
      createMatchRun,
    });
    await startMatchRun(VALID_INPUT, deps);
    expect(createMatchRun).toHaveBeenCalledTimes(1);
    expect(createMatchRun).toHaveBeenCalledWith({
      job_query_id: 'jq-1',
      tenant_id: 'tenant-xyz',
      triggered_by: 'app-user-1',
      catalog_snapshot_at: SNAPSHOT,
    });
  });

  it('calls preFilter with the resolved decomposition and tenant_id', async () => {
    const resolved = jobQuery();
    const preFilter = vi.fn(
      async (): Promise<PreFilterByMustHaveResult> => ({ included: [], excluded: [] }),
    );
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => ({
        resolved,
        catalog_snapshot_at: SNAPSHOT,
        tenant_id: 'tenant-xyz',
      })),
      preFilter,
    });
    await startMatchRun(VALID_INPUT, deps);
    expect(preFilter).toHaveBeenCalledTimes(1);
    expect(preFilter).toHaveBeenCalledWith(resolved, 'tenant-xyz');
  });

  it('stamps expected_count with included.length after preFilter', async () => {
    const setExpectedCount = vi.fn(async () => {});
    const deps = mkDeps({
      preFilter: vi.fn(
        async (): Promise<PreFilterByMustHaveResult> => ({
          included: ['c1', 'c2', 'c3', 'c4', 'c5'],
          excluded: [],
        }),
      ),
      setExpectedCount,
    });
    await startMatchRun(VALID_INPUT, deps);
    expect(setExpectedCount).toHaveBeenCalledTimes(1);
    expect(setExpectedCount).toHaveBeenCalledWith('run-1', 5);
  });

  it('returns the excluded list from preFilter untouched', async () => {
    const excluded: PreFilterExcludedCandidate[] = [
      { candidate_id: 'cE1', missing_must_have_skill_ids: ['s1'] },
      { candidate_id: 'cE2', missing_must_have_skill_ids: ['s1', 's2'] },
    ];
    const deps = mkDeps({
      preFilter: vi.fn(
        async (): Promise<PreFilterByMustHaveResult> => ({ included: [], excluded }),
      ),
    });
    const result = await startMatchRun(VALID_INPUT, deps);
    expect(result.excluded).toEqual(excluded);
    expect(result.total).toBe(0);
    expect(result.included).toEqual([]);
  });

  it('preserves dep ordering: loadJobQuery → createMatchRun → preFilter → setExpectedCount', async () => {
    const calls: string[] = [];
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => {
        calls.push('loadJobQuery');
        return { resolved: jobQuery(), catalog_snapshot_at: SNAPSHOT, tenant_id: null };
      }),
      createMatchRun: vi.fn(async () => {
        calls.push('createMatchRun');
        return { id: 'run-1' };
      }),
      preFilter: vi.fn(async (): Promise<PreFilterByMustHaveResult> => {
        calls.push('preFilter');
        return { included: ['c1'], excluded: [] };
      }),
      setExpectedCount: vi.fn(async () => {
        calls.push('setExpectedCount');
      }),
    });
    await startMatchRun(VALID_INPUT, deps);
    expect(calls).toEqual(['loadJobQuery', 'createMatchRun', 'preFilter', 'setExpectedCount']);
  });

  it('on preFilter failure, calls failMatchRun(reason) with the error message and rethrows', async () => {
    const failMatchRun = vi.fn(async () => {});
    const deps = mkDeps({
      preFilter: vi.fn(async () => {
        throw new Error('preFilter: simulated timeout');
      }),
      failMatchRun,
    });
    await expect(startMatchRun(VALID_INPUT, deps)).rejects.toThrow(/preFilter: simulated timeout/);
    expect(failMatchRun).toHaveBeenCalledTimes(1);
    expect(failMatchRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({
        finished_at: NOW,
        reason: 'preFilter: simulated timeout',
      }),
    );
  });

  it('on setExpectedCount failure, calls failMatchRun(reason) and rethrows', async () => {
    const failMatchRun = vi.fn(async () => {});
    const deps = mkDeps({
      setExpectedCount: vi.fn(async () => {
        throw new Error('setExpectedCount: pg_error');
      }),
      failMatchRun,
    });
    await expect(startMatchRun(VALID_INPUT, deps)).rejects.toThrow(/setExpectedCount: pg_error/);
    expect(failMatchRun).toHaveBeenCalledTimes(1);
    expect(failMatchRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ reason: 'setExpectedCount: pg_error' }),
    );
  });

  it('does NOT call failMatchRun when no run was created (loadJobQuery returned null)', async () => {
    const failMatchRun = vi.fn(async () => {});
    const deps = mkDeps({
      loadJobQuery: vi.fn(async () => null),
      failMatchRun,
    });
    await expect(startMatchRun(VALID_INPUT, deps)).rejects.toThrow(/job_query not found/i);
    expect(failMatchRun).not.toHaveBeenCalled();
  });

  it('uses deps.now (when provided) for failMatchRun finished_at', async () => {
    const customNow = new Date('2030-06-15T03:14:15Z');
    const failMatchRun = vi.fn(async () => {});
    const deps = mkDeps({
      now: () => customNow,
      preFilter: vi.fn(async () => {
        throw new Error('boom');
      }),
      failMatchRun,
    });
    await expect(startMatchRun(VALID_INPUT, deps)).rejects.toThrow();
    expect(failMatchRun).toHaveBeenCalledWith(
      'run-1',
      expect.objectContaining({ finished_at: customNow }),
    );
  });
});
