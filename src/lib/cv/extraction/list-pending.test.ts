/**
 * Adversarial tests for `listPendingExtractions`.
 *
 * The helper replaces a buggy inline `.not('id', 'in', ...)` clause
 * that broke with `URI too long` once the excluded set hit ~300
 * ids (Bloque 17 follow-up to the Bloque 16 embeddings regression).
 *
 * These tests intentionally do NOT exercise the happy `few excluded`
 * path in isolation — the integration test in
 * `tests/integration/cv/extraction-worker.test.ts` still covers the
 * end-to-end query against real Supabase. The goal here is to prove
 * the regression can't come back, not to document the base behavior.
 */
import { describe, expect, it } from 'vitest';

import type { SupabaseClient } from '@supabase/supabase-js';

import { listPendingExtractions } from './list-pending';

type FilterCall = { kind: string; args: unknown[] };

interface FakeTableData {
  rows: Array<Record<string, unknown>>;
}

interface FakeCallLog {
  from: string[];
  filters: FilterCall[];
}

function buildFakeDb(tables: Record<string, FakeTableData>): {
  db: SupabaseClient;
  calls: FakeCallLog;
} {
  const calls: FakeCallLog = { from: [], filters: [] };

  function makeBuilder(table: string) {
    const data = tables[table]?.rows ?? [];
    let limit: number | undefined;

    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: (col: string, val: unknown) => {
        calls.filters.push({ kind: 'eq', args: [table, col, val] });
        return builder;
      },
      is: (col: string, val: unknown) => {
        calls.filters.push({ kind: 'is', args: [table, col, val] });
        return builder;
      },
      not: (col: string, op: string, val: unknown) => {
        calls.filters.push({ kind: 'not', args: [table, col, op, val] });
        return builder;
      },
      in: (col: string, arr: unknown) => {
        calls.filters.push({ kind: 'in', args: [table, col, arr] });
        return builder;
      },
      order: (col: string, opts: unknown) => {
        calls.filters.push({ kind: 'order', args: [table, col, opts] });
        return builder;
      },
      limit: (n: number) => {
        limit = n;
        calls.filters.push({ kind: 'limit', args: [table, n] });
        return builder;
      },
      then: (resolve: (value: { data: unknown; error: null }) => unknown) => {
        const slice = typeof limit === 'number' ? data.slice(0, limit) : data;
        return Promise.resolve({ data: slice, error: null }).then(resolve);
      },
    };
    return builder;
  }

  const db = {
    from: (table: string) => {
      calls.from.push(table);
      return makeBuilder(table);
    },
  } as unknown as SupabaseClient;

  return { db, calls };
}

function makeFile(id: string, candidate: string, createdAt: string): Record<string, unknown> {
  return {
    id,
    candidate_id: candidate,
    parsed_text: `text-${id}`,
    created_at: createdAt,
  };
}

describe('listPendingExtractions', () => {
  it('never passes the excluded set inline to the URL (regression: URI too long)', async () => {
    const excluded = Array.from({ length: 500 }, (_, i) => ({ file_id: `excl-${i}` }));
    const files = Array.from({ length: 10 }, (_, i) =>
      makeFile(`new-${i}`, `c-${i}`, `2026-04-24T00:00:${i.toString().padStart(2, '0')}Z`),
    );
    const { db, calls } = buildFakeDb({
      candidate_extractions: { rows: excluded },
      files: { rows: files },
    });

    await listPendingExtractions(db, { model: 'm', promptVersion: 'v1', limit: 50 });

    const offenders = calls.filters.filter(
      (f) => f.kind === 'not' && (f.args[1] === 'id' || f.args[1] === 'file_id'),
    );
    expect(offenders).toEqual([]);
  });

  it('filters excluded files in memory and returns at most `limit`', async () => {
    const excluded = [{ file_id: 'f-1' }, { file_id: 'f-3' }];
    const files = [
      makeFile('f-1', 'c-1', '2026-04-24T00:00:01Z'),
      makeFile('f-2', 'c-2', '2026-04-24T00:00:02Z'),
      makeFile('f-3', 'c-3', '2026-04-24T00:00:03Z'),
      makeFile('f-4', 'c-4', '2026-04-24T00:00:04Z'),
    ];
    const { db } = buildFakeDb({
      candidate_extractions: { rows: excluded },
      files: { rows: files },
    });

    const out = await listPendingExtractions(db, { model: 'm', promptVersion: 'v1', limit: 2 });

    expect(out.map((r) => r.file_id)).toEqual(['f-2', 'f-4']);
    expect(out[0]).toMatchObject({ candidate_id: 'c-2', parsed_text: 'text-f-2' });
  });

  it('returns [] when no parsed files exist', async () => {
    const { db } = buildFakeDb({
      candidate_extractions: { rows: [] },
      files: { rows: [] },
    });

    const out = await listPendingExtractions(db, { model: 'm', promptVersion: 'v1', limit: 10 });

    expect(out).toEqual([]);
  });

  it('fetches enough rows to survive heavy filtering (limit + excluded upper bound)', async () => {
    // If `listPendingExtractions` naively asks Postgres for just
    // `limit` rows and the first `limit` happen to all be excluded,
    // it returns [] even though non-excluded rows exist further down.
    // Pre-fetching `limit + excluded.size` is the minimum that keeps
    // the worst case sound.
    const excluded = Array.from({ length: 5 }, (_, i) => ({ file_id: `f-${i}` }));
    const files = [
      ...Array.from({ length: 5 }, (_, i) =>
        makeFile(`f-${i}`, `c-${i}`, `2026-04-24T00:00:0${i}Z`),
      ),
      makeFile('f-5', 'c-5', '2026-04-24T00:00:05Z'),
      makeFile('f-6', 'c-6', '2026-04-24T00:00:06Z'),
    ];
    const { db, calls } = buildFakeDb({
      candidate_extractions: { rows: excluded },
      files: { rows: files },
    });

    const out = await listPendingExtractions(db, { model: 'm', promptVersion: 'v1', limit: 2 });

    expect(out.map((r) => r.file_id)).toEqual(['f-5', 'f-6']);
    const fileLimitCalls = calls.filters.filter((f) => f.kind === 'limit' && f.args[0] === 'files');
    expect(fileLimitCalls.length).toBe(1);
    const limitArg = fileLimitCalls[0]!.args[1] as number;
    expect(limitArg).toBeGreaterThanOrEqual(2 + excluded.length);
  });

  it('scopes the excluded lookup by model and prompt version', async () => {
    const { db, calls } = buildFakeDb({
      candidate_extractions: { rows: [] },
      files: { rows: [] },
    });

    await listPendingExtractions(db, { model: 'gpt-5-extract', promptVersion: 'v7', limit: 10 });

    const eqOnExisting = calls.filters.filter(
      (f) => f.kind === 'eq' && f.args[0] === 'candidate_extractions',
    );
    const cols = eqOnExisting.map((f) => f.args[1]);
    expect(cols).toContain('model');
    expect(cols).toContain('prompt_version');
    const byCol = new Map<string, unknown>(
      eqOnExisting.map((f) => [f.args[1] as string, f.args[2]]),
    );
    expect(byCol.get('model')).toBe('gpt-5-extract');
    expect(byCol.get('prompt_version')).toBe('v7');
  });
});
