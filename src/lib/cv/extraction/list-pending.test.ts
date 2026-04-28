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
    // ADR-029: dedup is by `content_hash`, not `file_id`. Build the
    // existing rows with the hashes that `text-f-1` and `text-f-3`
    // would produce under (model, prompt_version) so the helper
    // recognises them as already-extracted.
    const { extractionContentHash } = await import('./hash');
    const excluded = [
      { content_hash: extractionContentHash('text-f-1', 'm', 'v1') },
      { content_hash: extractionContentHash('text-f-3', 'm', 'v1') },
    ];
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
    // ADR-029: dedup by content_hash. Each excluded entry must match
    // the hash that `text-f-i` would produce.
    const { extractionContentHash } = await import('./hash');
    const excluded = Array.from({ length: 5 }, (_, i) => ({
      content_hash: extractionContentHash(`text-f-${i}`, 'm', 'v1'),
    }));
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

  // ────────────────────────────────────────────────────────────────
  // ADR-029: Re-extract when parsed_text changes
  // ────────────────────────────────────────────────────────────────
  // Bug surfaced when TT updates a CV: files row gets new content_hash,
  // parser nullifies parsed_text, parser re-runs producing new text, but
  // listPending skips the file because the OLD candidate_extractions row
  // still matches (file_id, model, prompt_version). The fix: dedupe by
  // the hash that the file *would* produce given its current parsed_text.

  it('test_re_extracts_when_parsed_text_changed_post_extraction', async () => {
    // The existing extraction was for parsed_text='OLD CV TEXT'; the file
    // now has parsed_text='NEW CV TEXT' (post re-parse). The old row's
    // content_hash differs from what NEW would hash to, so the file MUST
    // appear in pending.
    const { extractionContentHash } = await import('./hash');
    const oldHash = extractionContentHash('OLD CV TEXT', 'gpt-4o-mini', '2026-04-v1');
    const fileRow = {
      id: 'file-1',
      candidate_id: 'cand-1',
      parsed_text: 'NEW CV TEXT',
      created_at: '2026-04-24T00:00:00Z',
    };
    const { db } = buildFakeDb({
      candidate_extractions: { rows: [{ file_id: 'file-1', content_hash: oldHash }] },
      files: { rows: [fileRow] },
    });

    const out = await listPendingExtractions(db, {
      model: 'gpt-4o-mini',
      promptVersion: '2026-04-v1',
      limit: 10,
    });

    expect(out.map((r) => r.file_id)).toEqual(['file-1']);
  });

  it('test_skips_when_text_unchanged_and_hash_matches', async () => {
    // Steady state: the existing extraction's hash matches what the
    // file's current parsed_text would hash to → file is up-to-date and
    // should NOT appear in pending.
    const { extractionContentHash } = await import('./hash');
    const currentHash = extractionContentHash('SAME TEXT', 'gpt-4o-mini', '2026-04-v1');
    const fileRow = {
      id: 'file-1',
      candidate_id: 'cand-1',
      parsed_text: 'SAME TEXT',
      created_at: '2026-04-24T00:00:00Z',
    };
    const { db } = buildFakeDb({
      candidate_extractions: { rows: [{ file_id: 'file-1', content_hash: currentHash }] },
      files: { rows: [fileRow] },
    });

    const out = await listPendingExtractions(db, {
      model: 'gpt-4o-mini',
      promptVersion: '2026-04-v1',
      limit: 10,
    });

    expect(out).toEqual([]);
  });

  it('test_existing_query_selects_content_hash_not_just_file_id', async () => {
    // Pin the contract: the helper must read content_hash from existing
    // rows (otherwise the comparison in test_re_extracts_when_text_changed
    // can't be done). Without this, a future refactor that drops
    // content_hash from the select silently breaks the fix.
    let selectArg: unknown = null;
    const captureSelectDb = {
      from: (table: string) => {
        if (table !== 'candidate_extractions') {
          return {
            select: () => ({
              eq: () => ({
                eq: () => ({
                  then: (r: (v: unknown) => unknown) =>
                    Promise.resolve({ data: [], error: null }).then(r),
                }),
              }),
              is: () => ({
                not: () => ({
                  is: () => ({
                    order: () => ({
                      limit: () => ({
                        then: (r: (v: unknown) => unknown) =>
                          Promise.resolve({ data: [], error: null }).then(r),
                      }),
                    }),
                  }),
                }),
              }),
            }),
          };
        }
        return {
          select: (cols: string) => {
            selectArg = cols;
            return {
              eq: () => ({
                eq: () => ({
                  then: (r: (v: unknown) => unknown) =>
                    Promise.resolve({ data: [], error: null }).then(r),
                }),
              }),
            };
          },
        };
      },
    } as unknown as SupabaseClient;

    await listPendingExtractions(captureSelectDb, {
      model: 'm',
      promptVersion: 'v1',
      limit: 5,
    });

    expect(selectArg).toMatch(/content_hash/);
  });
});
