/**
 * Adversarial tests for `buildRunMatchJobDeps.insertMatchResults`.
 *
 * Background (2026-05-21 validation of ADR-031). The parallel
 * chunked-IN fan-out cut the read phase of `runMatchJob` from ~30s
 * to ~14s on a 5_500-candidate pool, but the wall-clock still
 * blew Heroku H12 because `insertMatchResults` issues a SINGLE bulk
 * `.insert([...5500 rows])` that hits Postgres `statement_timeout`
 * (~27s observed) and aborts the run with
 * `canceling statement due to statement timeout`. ADR-032 chunks
 * the insert into batches so each statement stays well under the
 * timeout.
 *
 * These tests pin the contract: same input rows go to the same
 * table, in the same order, with the same `match_run_id`, but
 * split across N inserts of bounded size — without depending on
 * the exact `INSERT_CHUNK_SIZE` constant (which may move with
 * tuning).
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { describe, expect, it } from 'vitest';

import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import { buildRunMatchJobDeps } from './db-deps';
import type { MatchResultRow } from './run-match-job';

interface FakeInsertCall {
  table: string;
  rows: Array<Record<string, unknown>>;
}

interface FakeRpcCall {
  name: string;
  args: Record<string, unknown>;
}

interface FakeSelectCall {
  table: string;
  columns: string;
}

function makeFakeSupabase(): {
  client: SupabaseClient;
  calls: FakeInsertCall[];
  rpcCalls: FakeRpcCall[];
  selectCalls: FakeSelectCall[];
  failNextWith: (msg: string) => void;
  failAtCall: (callIdx: number, msg: string) => void;
  setRpcData: (name: string, data: unknown) => void;
  setRpcError: (name: string, msg: string) => void;
} {
  const calls: FakeInsertCall[] = [];
  const rpcCalls: FakeRpcCall[] = [];
  const selectCalls: FakeSelectCall[] = [];
  let oneShotError: string | null = null;
  const failByIndex: Map<number, string> = new Map();
  const rpcData = new Map<string, unknown>();
  const rpcErrors = new Map<string, string>();

  const fake = {
    from(table: string) {
      return {
        insert(rows: Array<Record<string, unknown>>) {
          const callIdx = calls.length;
          calls.push({ table, rows: rows.map((r) => ({ ...r })) });
          let err: { message: string } | null = null;
          if (oneShotError !== null) {
            err = { message: oneShotError };
            oneShotError = null;
          } else if (failByIndex.has(callIdx)) {
            err = { message: failByIndex.get(callIdx)! };
          }
          return Promise.resolve({ data: null, error: err });
        },
        select(columns: string) {
          // Recording-only: the post-ADR-033 impl no longer reads via
          // .from(...).select() in the matching pipeline (preFilter +
          // loadCandidates go through .rpc). Any select in those paths
          // is a regression.
          selectCalls.push({ table, columns });
          const chain = {
            range: () => Promise.resolve({ data: [], error: null }),
            in: () => chain,
            eq: () => chain,
          };
          return chain;
        },
      };
    },
    rpc(name: string, args: Record<string, unknown>) {
      rpcCalls.push({ name, args });
      const errMsg = rpcErrors.get(name);
      if (errMsg !== undefined) {
        return Promise.resolve({ data: null, error: { message: errMsg } });
      }
      return Promise.resolve({ data: rpcData.get(name) ?? null, error: null });
    },
  };

  return {
    client: fake as unknown as SupabaseClient,
    calls,
    rpcCalls,
    selectCalls,
    failNextWith: (msg) => {
      oneShotError = msg;
    },
    failAtCall: (callIdx, msg) => {
      failByIndex.set(callIdx, msg);
    },
    setRpcData: (name, data) => {
      rpcData.set(name, data);
    },
    setRpcError: (name, msg) => {
      rpcErrors.set(name, msg);
    },
  };
}

/**
 * Stub `ResolvedDecomposition` builder for preFilter tests. Only the
 * fields preFilter inspects (`requirements[]`) are meaningful; the
 * rest is filled with safe defaults so tests don't depend on shape
 * changes elsewhere.
 */
function mkResolved(
  requirements: Array<{
    skill_id: string | null;
    must_have: boolean;
    alternative_group_id: string | null;
    skill_raw?: string;
  }>,
): ResolvedDecomposition {
  return {
    requirements: requirements.map((r) => ({
      skill_raw: r.skill_raw ?? 'stub',
      skill_id: r.skill_id,
      resolved_at: r.skill_id === null ? null : '2026-05-21T00:00:00.000Z',
      min_years: null,
      max_years: null,
      must_have: r.must_have,
      evidence_snippet: 'stub evidence',
      category: 'technical',
      alternative_group_id: r.alternative_group_id,
    })),
    seniority: 'unspecified',
    languages: [],
    notes: null,
    role_essentials: [],
  };
}

function mkRows(n: number, runId = 'run-test-0001'): MatchResultRow[] {
  return Array.from({ length: n }, (_, i) => ({
    candidate_id: `cand-${i.toString().padStart(5, '0')}`,
    tenant_id: null,
    total_score: 0.5 + (i % 100) / 1000,
    must_have_gate: (i % 2 === 0 ? 'passed' : 'failed') as 'passed' | 'failed',
    rank: i + 1,
    breakdown_json: { i, runId },
  }));
}

describe('buildRunMatchJobDeps.insertMatchResults', () => {
  it('no-op when rows are empty (does not touch supabase)', async () => {
    const { client, calls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    await deps.insertMatchResults('run-1', []);
    expect(calls).toEqual([]);
  });

  it('issues a single insert call when rows fit comfortably under any chunk threshold', async () => {
    const { client, calls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    await deps.insertMatchResults('run-1', mkRows(10));
    expect(calls).toHaveLength(1);
    expect(calls[0]!.table).toBe('match_results');
    expect(calls[0]!.rows).toHaveLength(10);
  });

  // ─────────────────────────────────────────────────────────────
  // RED: chunked-INSERT contract (ADR-032).
  //
  // Today's impl emits one `.insert([...rows])` regardless of N.
  // At 5_500+ rows that single statement times out in Postgres.
  // These tests pin the post-fix contract WITHOUT pinning a
  // specific chunk size — only that the impl MUST chunk, MUST
  // stay below 1_000 rows per statement (well under the body
  // and statement-timeout ceilings), and MUST preserve order +
  // completeness.
  // ─────────────────────────────────────────────────────────────

  it('splits a 1_500-row insert into multiple chunks, each ≤ 1_000 rows', async () => {
    const { client, calls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    await deps.insertMatchResults('run-1', mkRows(1_500));
    expect(calls.length).toBeGreaterThan(1);
    for (const c of calls) {
      expect(c.table).toBe('match_results');
      expect(c.rows.length).toBeLessThanOrEqual(1_000);
      expect(c.rows.length).toBeGreaterThan(0);
    }
  });

  it('preserves total row count across chunks (no duplicates, no drops)', async () => {
    const { client, calls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    const N = 2_345;
    await deps.insertMatchResults('run-1', mkRows(N));
    const total = calls.reduce((acc, c) => acc + c.rows.length, 0);
    expect(total).toBe(N);
    // Every input rank appears exactly once across all chunks.
    const seenRanks = new Set<number>();
    for (const c of calls) {
      for (const r of c.rows) {
        const rank = r.rank as number;
        expect(seenRanks.has(rank)).toBe(false);
        seenRanks.add(rank);
      }
    }
    expect(seenRanks.size).toBe(N);
  });

  it('preserves input row order across chunks', async () => {
    const { client, calls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    const rows = mkRows(1_500);
    await deps.insertMatchResults('run-1', rows);
    // Flattened chunk-by-chunk sequence must equal the input
    // candidate_id sequence — the ranker emits results in
    // descending score, callers (and `rank` indexing) rely on
    // chunked-INSERT preserving that.
    const flatCandidateIds: string[] = [];
    for (const c of calls) {
      for (const r of c.rows) flatCandidateIds.push(r.candidate_id as string);
    }
    expect(flatCandidateIds).toEqual(rows.map((r) => r.candidate_id));
  });

  it('tags every row across every chunk with the same match_run_id', async () => {
    const { client, calls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    await deps.insertMatchResults('run-abc-123', mkRows(1_500));
    for (const c of calls) {
      for (const r of c.rows) {
        expect(r.match_run_id).toBe('run-abc-123');
      }
    }
  });

  it('on chunk failure mid-stream, surfaces the error and stops issuing further chunks', async () => {
    // Inject a failure on the second insert. Pre-fix code only
    // ever issues one insert, so this test also locks in that
    // the impl actually issues > 1 call when it should.
    const { client, calls, failAtCall } = makeFakeSupabase();
    failAtCall(1, 'simulated_pg_error');
    const deps = buildRunMatchJobDeps(client);

    await expect(deps.insertMatchResults('run-1', mkRows(1_500))).rejects.toThrow(
      /simulated_pg_error/,
    );
    // The 1st chunk landed, the 2nd failed, the 3rd+ must NOT be
    // attempted (matches the existing all-or-fail contract — the
    // run is stamped failed by `failMatchRun` upstream).
    expect(calls.length).toBeGreaterThanOrEqual(2);
    expect(calls.length).toBeLessThan(4);
  });

  it('surfaces the first chunk error without retrying', async () => {
    const { client, calls, failNextWith } = makeFakeSupabase();
    failNextWith('pg_error_first_chunk');
    const deps = buildRunMatchJobDeps(client);
    await expect(deps.insertMatchResults('run-1', mkRows(2_000))).rejects.toThrow(
      /pg_error_first_chunk/,
    );
    expect(calls).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────
// ADR-033 — Wire-up of `preFilter` and `loadCandidates` to the
// server-side RPCs (`match_pre_filter`, `match_load_aggregates`).
//
// Pre-fix: both deps used chunked-IN `.from(...).select(...).range()`
// fan-out (~14 s on 8 700 cands). Post-fix: each is ONE round-trip
// via `.rpc(...)`. These tests pin the wiring contract — that the
// deps actually call the right RPC with the right payload, and that
// they no longer touch `.from(...)` for read paths in the matching
// pipeline.
// ─────────────────────────────────────────────────────────────────

describe('buildRunMatchJobDeps.preFilter — ADR-033', () => {
  it('calls match_pre_filter RPC with derived groups + tenant_id and returns the deserialized payload', async () => {
    const { client, rpcCalls, setRpcData } = makeFakeSupabase();
    setRpcData('match_pre_filter', {
      included: ['cand-1', 'cand-2'],
      excluded: [{ candidate_id: 'cand-3', missing_must_have_skill_ids: ['skill-A'] }],
    });

    const deps = buildRunMatchJobDeps(client);
    const jobQuery = mkResolved([
      { skill_id: 'skill-A', must_have: true, alternative_group_id: null },
      // unresolved must-have → dropped from groups (ADR-015 / ADR-021)
      { skill_id: null, must_have: true, alternative_group_id: null },
      // non-must-have → ignored even if resolved
      { skill_id: 'skill-Z', must_have: false, alternative_group_id: null },
    ]);

    const result = await deps.preFilter(jobQuery, 'tenant-xyz');

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe('match_pre_filter');
    // ADR-036: `any_of_skill_ids_in` is the flat union of every
    // resolved skill_id (must + soft). skill-A (must, resolved) +
    // skill-Z (soft, resolved); the unresolved must row contributes
    // nothing. Order is stable by first appearance.
    expect(rpcCalls[0]!.args).toEqual({
      must_have_groups_in: [{ skill_ids: ['skill-A'] }],
      tenant_id_in: 'tenant-xyz',
      any_of_skill_ids_in: ['skill-A', 'skill-Z'],
    });
    expect(result.included).toEqual(['cand-1', 'cand-2']);
    expect(result.excluded).toEqual([
      { candidate_id: 'cand-3', missing_must_have_skill_ids: ['skill-A'] },
    ]);
  });

  it('collapses requirements sharing an alternative_group_id into one OR-group', async () => {
    const { client, rpcCalls, setRpcData } = makeFakeSupabase();
    setRpcData('match_pre_filter', { included: [], excluded: [] });

    const deps = buildRunMatchJobDeps(client);
    const jobQuery = mkResolved([
      { skill_id: 'skill-A', must_have: true, alternative_group_id: 'or-1' },
      { skill_id: 'skill-B', must_have: true, alternative_group_id: 'or-1' },
      { skill_id: 'skill-C', must_have: true, alternative_group_id: null },
    ]);

    await deps.preFilter(jobQuery, null);

    const args = rpcCalls[0]!.args as {
      must_have_groups_in: Array<{ skill_ids: string[] }>;
    };
    // Two groups: singleton {C} (emitted first per pre-filter.ts impl)
    // and the OR-group {A,B}. Order within "groups" is unspecified by
    // the contract — assert by set membership.
    expect(args.must_have_groups_in).toHaveLength(2);
    const sets = args.must_have_groups_in.map((g) => new Set(g.skill_ids));
    expect(sets).toContainEqual(new Set(['skill-C']));
    expect(sets).toContainEqual(new Set(['skill-A', 'skill-B']));
  });

  it('does NOT issue any .from(...).select() for reads (single RPC round-trip)', async () => {
    const { client, selectCalls, rpcCalls, setRpcData } = makeFakeSupabase();
    setRpcData('match_pre_filter', { included: [], excluded: [] });

    const deps = buildRunMatchJobDeps(client);
    const jobQuery = mkResolved([
      { skill_id: 'skill-A', must_have: true, alternative_group_id: null },
    ]);
    await deps.preFilter(jobQuery, null);

    // Pre-ADR-033: would have fired `.from('candidates').select('id').range(...)`
    // and `.from('experience_skills').select(...).in(...).range(...)`.
    expect(selectCalls).toEqual([]);
    expect(rpcCalls.map((c) => c.name)).toEqual(['match_pre_filter']);
  });

  it('surfaces RPC errors with the dep label', async () => {
    const { client, setRpcError } = makeFakeSupabase();
    setRpcError('match_pre_filter', 'permission denied for function match_pre_filter');

    const deps = buildRunMatchJobDeps(client);
    const jobQuery = mkResolved([
      { skill_id: 'skill-A', must_have: true, alternative_group_id: null },
    ]);

    await expect(deps.preFilter(jobQuery, null)).rejects.toThrow(/permission denied/);
  });

  it('empty must-have set still calls the RPC (returns server-side full pool)', async () => {
    // Per ADR-033 §RPC #1: empty groups input → RPC returns every
    // (tenant-visible) candidate as included. We do NOT short-circuit
    // in JS — that would re-introduce a chunked-IN fan-out for
    // `candidates`, which is exactly the cost we just eliminated.
    const { client, rpcCalls, setRpcData } = makeFakeSupabase();
    setRpcData('match_pre_filter', {
      included: ['cand-1', 'cand-2', 'cand-3'],
      excluded: [],
    });

    const deps = buildRunMatchJobDeps(client);
    const jobQuery = mkResolved([
      // all must-have unresolved → dropped → zero active groups
      { skill_id: null, must_have: true, alternative_group_id: null },
    ]);

    const result = await deps.preFilter(jobQuery, null);

    expect(rpcCalls).toHaveLength(1);
    // ADR-036: zero resolved requirements → union is empty → the
    // adapter passes `null` so the RPC's `any_of_active` branch
    // stays off and the candidate pool is not narrowed.
    expect(rpcCalls[0]!.args).toEqual({
      must_have_groups_in: [],
      tenant_id_in: null,
      any_of_skill_ids_in: null,
    });
    expect(result.included).toEqual(['cand-1', 'cand-2', 'cand-3']);
    expect(result.excluded).toEqual([]);
  });
});

describe('buildRunMatchJobDeps.loadCandidates — ADR-033', () => {
  it('returns [] without touching the RPC when input is empty', async () => {
    const { client, rpcCalls, selectCalls } = makeFakeSupabase();
    const deps = buildRunMatchJobDeps(client);
    const out = await deps.loadCandidates([]);
    expect(out).toEqual([]);
    expect(rpcCalls).toEqual([]);
    expect(selectCalls).toEqual([]);
  });

  it('calls match_load_aggregates RPC and assembles CandidateAggregate[] with merged_experiences', async () => {
    const { client, rpcCalls, setRpcData } = makeFakeSupabase();
    setRpcData('match_load_aggregates', [
      {
        candidate_id: 'c1',
        experiences: [
          {
            id: 'exp-1',
            source_variant: 'cv_primary',
            kind: 'work',
            company: 'Acme',
            title: 'Engineer',
            start_date: '2020-01-01',
            end_date: '2022-12-31',
            description: 'work',
            skills: [{ skill_id: 'sk-1', skill_raw: 'TypeScript' }],
          },
        ],
        languages: [{ name: 'English', level: 'C1' }],
      },
    ]);

    const deps = buildRunMatchJobDeps(client);
    const out = await deps.loadCandidates(['c1']);

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]!.name).toBe('match_load_aggregates');
    expect(rpcCalls[0]!.args).toEqual({
      candidate_ids_in: ['c1'],
      tenant_id_in: null,
    });

    expect(out).toHaveLength(1);
    expect(out[0]!.candidate_id).toBe('c1');
    // mergeVariants(exps with one cv_primary row) → returns the row as-is.
    expect(out[0]!.merged_experiences).toHaveLength(1);
    expect(out[0]!.merged_experiences[0]!.id).toBe('exp-1');
    expect(out[0]!.merged_experiences[0]!.skills).toEqual([
      { skill_id: 'sk-1', skill_raw: 'TypeScript' },
    ]);
    expect(out[0]!.languages).toEqual([{ name: 'English', level: 'C1' }]);
  });

  it('does NOT issue chunked .from(...).select() for read paths', async () => {
    const { client, selectCalls, setRpcData } = makeFakeSupabase();
    setRpcData('match_load_aggregates', []);
    const deps = buildRunMatchJobDeps(client);
    await deps.loadCandidates(['c1', 'c2']);
    // Pre-ADR-033: `.from('candidate_experiences').select(...).in(...).range(...)`
    // and `.from('candidate_languages').select(...).in(...).range(...)`.
    expect(selectCalls).toEqual([]);
  });

  it('preserves input candidate order; missing-from-rpc candidates get empty arrays', async () => {
    // Defensive: matches the prior loadCandidateAggregates contract —
    // every input id appears in the output exactly once, in the same
    // order, even when the RPC omits a candidate (e.g. RLS-filtered).
    const { client, setRpcData } = makeFakeSupabase();
    setRpcData('match_load_aggregates', [
      {
        candidate_id: 'c2',
        experiences: [],
        languages: [{ name: 'Spanish', level: null }],
      },
    ]);
    const deps = buildRunMatchJobDeps(client);
    const out = await deps.loadCandidates(['c1', 'c2', 'c3']);

    expect(out.map((c) => c.candidate_id)).toEqual(['c1', 'c2', 'c3']);
    expect(out[0]!.merged_experiences).toEqual([]);
    expect(out[0]!.languages).toEqual([]);
    expect(out[1]!.merged_experiences).toEqual([]);
    expect(out[1]!.languages).toEqual([{ name: 'Spanish', level: null }]);
    expect(out[2]!.merged_experiences).toEqual([]);
    expect(out[2]!.languages).toEqual([]);
  });

  it('surfaces RPC errors with the dep label', async () => {
    const { client, setRpcError } = makeFakeSupabase();
    setRpcError('match_load_aggregates', 'statement timeout');
    const deps = buildRunMatchJobDeps(client);
    await expect(deps.loadCandidates(['c1'])).rejects.toThrow(/statement timeout/);
  });
});
