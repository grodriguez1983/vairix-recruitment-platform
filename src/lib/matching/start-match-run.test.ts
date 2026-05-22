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

import type {
  ResolvedDecomposition,
  ResolvedRequirement,
} from '../rag/decomposition/resolve-requirements';

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
    persistEffectiveResolved: vi.fn(async () => {}),
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

function req(partial: Partial<ResolvedRequirement> = {}): ResolvedRequirement {
  return {
    skill_raw: 'python',
    min_years: 3,
    max_years: null,
    must_have: true,
    evidence_snippet: '5+ years of Python',
    category: 'technical',
    alternative_group_id: null,
    skill_id: 'skill-python',
    resolved_at: '2025-01-01T00:00:00Z',
    ...partial,
  };
}

function jobQueryWith(requirements: ResolvedRequirement[]): ResolvedDecomposition {
  return {
    requirements,
    seniority: 'unspecified',
    languages: [],
    notes: null,
    role_essentials: [],
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

  describe('effective resolved snapshot (ADR-035)', () => {
    it('no override: persists loaded.resolved as the effective snapshot before preFilter', async () => {
      const original = jobQueryWith([req()]);
      const calls: string[] = [];
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
        persistEffectiveResolved: vi.fn(async (_runId, resolved) => {
          calls.push('persist');
          expect(resolved).toEqual(original);
        }),
        preFilter: vi.fn(async (resolved) => {
          calls.push('preFilter');
          expect(resolved).toEqual(original);
          return { included: [], excluded: [] };
        }),
      });
      await startMatchRun(VALID_INPUT, deps);
      // Snapshot must be sealed BEFORE preFilter runs so a crash mid-run
      // leaves an auditable record of what was about to be ranked.
      expect(calls).toEqual(['persist', 'preFilter']);
    });

    it('with override: applies override to preFilter (not loaded.resolved)', async () => {
      const original = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python', min_years: 3, must_have: true }),
        req({ skill_id: 'skill-react', skill_raw: 'react', min_years: 5, must_have: true }),
      ]);
      // Override: drop react, soften python's min_years, untoggle must_have.
      const override = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python', min_years: 1, must_have: false }),
      ]);
      const preFilter = vi.fn(
        async (): Promise<PreFilterByMustHaveResult> => ({ included: [], excluded: [] }),
      );
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
        preFilter,
      });
      await startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps);
      expect(preFilter).toHaveBeenCalledWith(override, null);
    });

    it('with override: persists the override (not loaded.resolved) as the snapshot', async () => {
      const original = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python', min_years: 3, must_have: true }),
        req({ skill_id: 'skill-react', skill_raw: 'react', min_years: 5, must_have: true }),
      ]);
      const override = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python', min_years: 1, must_have: false }),
      ]);
      const persistEffectiveResolved = vi.fn(async () => {});
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
        persistEffectiveResolved,
      });
      await startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps);
      expect(persistEffectiveResolved).toHaveBeenCalledTimes(1);
      expect(persistEffectiveResolved).toHaveBeenCalledWith('run-1', override);
    });

    it('rejects override that introduces a skill_id not in original (no inventing requirements)', async () => {
      const original = jobQueryWith([req({ skill_id: 'skill-python', skill_raw: 'python' })]);
      const override = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python' }),
        req({ skill_id: 'skill-rust', skill_raw: 'rust' }), // not in original
      ]);
      const failMatchRun = vi.fn(async () => {});
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
        failMatchRun,
      });
      await expect(
        startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps),
      ).rejects.toThrow(/invalid_override/i);
      // No run is created → no need to fail it. The check runs pre-create.
      expect(failMatchRun).not.toHaveBeenCalled();
    });

    it('rejects override that changes the skill_id of a requirement (identity is LLM-owned)', async () => {
      const original = jobQueryWith([req({ skill_id: 'skill-python', skill_raw: 'python' })]);
      const override = jobQueryWith([
        req({ skill_id: 'skill-rust', skill_raw: 'python' }), // skill_raw same, skill_id swapped
      ]);
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
      });
      await expect(
        startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps),
      ).rejects.toThrow(/invalid_override/i);
    });

    it('rejects override that changes seniority (out of scope for editing this pass)', async () => {
      const original: ResolvedDecomposition = {
        ...jobQueryWith([req()]),
        seniority: 'senior',
      };
      const override: ResolvedDecomposition = {
        ...original,
        seniority: 'junior',
      };
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
      });
      await expect(
        startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps),
      ).rejects.toThrow(/invalid_override/i);
    });

    it('accepts override that omits requirements (delete is allowed)', async () => {
      const original = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python' }),
        req({ skill_id: 'skill-react', skill_raw: 'react' }),
      ]);
      const override = jobQueryWith([req({ skill_id: 'skill-python', skill_raw: 'python' })]);
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
      });
      await expect(
        startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps),
      ).resolves.toBeDefined();
    });

    it('accepts override that changes min_years and must_have on existing requirements', async () => {
      const original = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python', min_years: 5, must_have: true }),
      ]);
      const override = jobQueryWith([
        req({ skill_id: 'skill-python', skill_raw: 'python', min_years: 0, must_have: false }),
      ]);
      const deps = mkDeps({
        loadJobQuery: vi.fn(async () => ({
          resolved: original,
          catalog_snapshot_at: SNAPSHOT,
          tenant_id: null,
        })),
      });
      await expect(
        startMatchRun({ ...VALID_INPUT, resolvedOverride: override }, deps),
      ).resolves.toBeDefined();
    });
  });
});
