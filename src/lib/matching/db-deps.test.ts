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

import { buildRunMatchJobDeps } from './db-deps';
import type { MatchResultRow } from './run-match-job';

interface FakeInsertCall {
  table: string;
  rows: Array<Record<string, unknown>>;
}

function makeFakeSupabase(): {
  client: SupabaseClient;
  calls: FakeInsertCall[];
  failNextWith: (msg: string) => void;
  failAtCall: (callIdx: number, msg: string) => void;
} {
  const calls: FakeInsertCall[] = [];
  let oneShotError: string | null = null;
  const failByIndex: Map<number, string> = new Map();

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
      };
    },
  };

  return {
    client: fake as unknown as SupabaseClient,
    calls,
    failNextWith: (msg) => {
      oneShotError = msg;
    },
    failAtCall: (callIdx, msg) => {
      failByIndex.set(callIdx, msg);
    },
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
