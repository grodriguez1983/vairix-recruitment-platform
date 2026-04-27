/**
 * Unit tests for the generic incremental sync runner.
 *
 * These exercise transport-agnostic runner behavior (pagination cap,
 * batch dispatch) with a fully faked client and a mocked lock module.
 * E2E coverage that hits Supabase local lives under
 * `tests/integration/sync/*.test.ts`.
 */
import { describe, expect, it, vi } from 'vitest';

import type { TTParsedResource } from '../teamtailor/types';

vi.mock('./lock', () => ({
  acquireLock: vi.fn().mockResolvedValue({
    lastRunStartedAt: '2026-04-19T00:00:00.000Z',
    lastSyncedAt: null,
    lastCursor: null,
  }),
  releaseLock: vi.fn().mockResolvedValue(undefined),
}));

import { acquireLock, releaseLock } from './lock';
import { runIncremental, type EntitySyncer, type SyncerDeps } from './run';

function makeResource(id: string): TTParsedResource {
  return {
    id,
    type: 'test-entity',
    attributes: { name: `r-${id}` },
    relationships: {},
  };
}

async function* yieldN(n: number): AsyncGenerator<TTParsedResource> {
  for (let i = 0; i < n; i += 1) yield makeResource(String(i));
}

function fakeClient(total: number): SyncerDeps['client'] {
  return {
    paginate: () => yieldN(total),
    paginateWithIncluded: () => {
      throw new Error('paginateWithIncluded not used in this test');
    },
  } as unknown as SyncerDeps['client'];
}

interface Row {
  teamtailor_id: string;
}

function fakeSyncer(upserts: Row[][]): EntitySyncer<Row> {
  return {
    entity: 'test-entity',
    buildInitialRequest: () => ({ path: '/test', params: {} }),
    mapResource: (r) => ({ teamtailor_id: r.id }),
    upsert: async (rows) => {
      upserts.push([...rows]);
      return rows.length;
    },
  };
}

describe('runIncremental / maxRecords cap', () => {
  it('stops pagination after maxRecords resources yielded', async () => {
    const upserts: Row[][] = [];
    const syncer = fakeSyncer(upserts);
    const deps = {
      db: {} as SyncerDeps['db'],
      client: fakeClient(200),
      maxRecords: 5,
    } as SyncerDeps;

    const result = await runIncremental(syncer, deps);

    expect(result.recordsSynced).toBe(5);
    const flat = upserts.flat();
    expect(flat).toHaveLength(5);
    expect(flat.map((r) => r.teamtailor_id)).toEqual(['0', '1', '2', '3', '4']);
  });

  it('ignores cap when maxRecords is undefined and drains all pages', async () => {
    const upserts: Row[][] = [];
    const syncer = fakeSyncer(upserts);
    const deps = {
      db: {} as SyncerDeps['db'],
      client: fakeClient(120),
    } as SyncerDeps;

    const result = await runIncremental(syncer, deps);

    expect(result.recordsSynced).toBe(120);
    expect(upserts.flat()).toHaveLength(120);
  });
});

// ──────────────────────────────────────────────────────────────────
// ADR-027 — Persistencia del `last_cursor` en éxito + fallback al
// `last_synced_at` cuando `last_cursor` es null (rows pre-fix).
// ──────────────────────────────────────────────────────────────────

function syncerCapturingCursor(opts: {
  upserts: Row[][];
  cursorSeen: { value: string | null | undefined };
}): EntitySyncer<Row> {
  return {
    entity: 'test-entity',
    buildInitialRequest: (cursor) => {
      // Capture what runIncremental hands us so the test can assert.
      opts.cursorSeen.value = cursor;
      return { path: '/test', params: {} };
    },
    mapResource: (r) => ({ teamtailor_id: r.id }),
    upsert: async (rows) => {
      opts.upserts.push([...rows]);
      return rows.length;
    },
  };
}

describe('runIncremental / ADR-027 cursor persistence', () => {
  it('test_persists_run_started_at_as_last_cursor_on_success', async () => {
    vi.mocked(acquireLock).mockResolvedValueOnce({
      lastRunStartedAt: '2026-04-27T10:00:00.000Z',
      lastSyncedAt: '2026-04-27T09:00:00.000Z',
      lastCursor: '2026-04-27T09:00:00.000Z',
    } as Awaited<ReturnType<typeof acquireLock>>);
    vi.mocked(releaseLock).mockClear();

    const upserts: Row[][] = [];
    const cursorSeen = { value: undefined as string | null | undefined };
    const syncer = syncerCapturingCursor({ upserts, cursorSeen });

    await runIncremental(syncer, {
      db: {} as SyncerDeps['db'],
      client: fakeClient(3),
    } as SyncerDeps);

    expect(releaseLock).toHaveBeenCalledTimes(1);
    const outcome = vi.mocked(releaseLock).mock.calls[0]?.[2];
    expect(outcome?.status).toBe('success');
    if (outcome?.status === 'success') {
      // Cursor written must be the run-start timestamp so the next
      // run resumes from this watermark.
      expect(outcome.lastCursor).toBe('2026-04-27T10:00:00.000Z');
      // last_synced_at semantics unchanged.
      expect(outcome.lastSyncedAt).toBe('2026-04-27T10:00:00.000Z');
    }
  });

  it('test_uses_last_cursor_when_present', async () => {
    vi.mocked(acquireLock).mockResolvedValueOnce({
      lastRunStartedAt: '2026-04-27T10:00:00.000Z',
      lastSyncedAt: '2026-04-26T00:00:00.000Z',
      lastCursor: '2026-04-26T12:00:00.000Z',
    } as Awaited<ReturnType<typeof acquireLock>>);

    const cursorSeen = { value: undefined as string | null | undefined };
    const syncer = syncerCapturingCursor({ upserts: [], cursorSeen });

    await runIncremental(syncer, {
      db: {} as SyncerDeps['db'],
      client: fakeClient(0),
    } as SyncerDeps);

    expect(cursorSeen.value).toBe('2026-04-26T12:00:00.000Z');
  });

  it('test_falls_back_to_last_synced_at_when_cursor_is_null', async () => {
    // Backward compat: rows persisted before ADR-027 have last_cursor
    // null but last_synced_at populated. The runner must use that as
    // the cursor seed so the first post-fix run is genuinely
    // incremental instead of a full scan.
    vi.mocked(acquireLock).mockResolvedValueOnce({
      lastRunStartedAt: '2026-04-27T10:00:00.000Z',
      lastSyncedAt: '2026-04-26T00:00:00.000Z',
      lastCursor: null,
    } as Awaited<ReturnType<typeof acquireLock>>);

    const cursorSeen = { value: undefined as string | null | undefined };
    const syncer = syncerCapturingCursor({ upserts: [], cursorSeen });

    await runIncremental(syncer, {
      db: {} as SyncerDeps['db'],
      client: fakeClient(0),
    } as SyncerDeps);

    expect(cursorSeen.value).toBe('2026-04-26T00:00:00.000Z');
  });

  it('test_passes_null_cursor_when_both_are_null_first_ever_run', async () => {
    vi.mocked(acquireLock).mockResolvedValueOnce({
      lastRunStartedAt: '2026-04-27T10:00:00.000Z',
      lastSyncedAt: null,
      lastCursor: null,
    } as Awaited<ReturnType<typeof acquireLock>>);

    const cursorSeen = { value: undefined as string | null | undefined };
    const syncer = syncerCapturingCursor({ upserts: [], cursorSeen });

    await runIncremental(syncer, {
      db: {} as SyncerDeps['db'],
      client: fakeClient(0),
    } as SyncerDeps);

    expect(cursorSeen.value).toBeNull();
  });

  it('test_does_not_advance_cursor_on_error_path', async () => {
    vi.mocked(acquireLock).mockResolvedValueOnce({
      lastRunStartedAt: '2026-04-27T10:00:00.000Z',
      lastSyncedAt: '2026-04-26T00:00:00.000Z',
      lastCursor: '2026-04-26T12:00:00.000Z',
    } as Awaited<ReturnType<typeof acquireLock>>);
    vi.mocked(releaseLock).mockClear();

    const failingSyncer: EntitySyncer<Row> = {
      entity: 'test-entity',
      buildInitialRequest: () => ({ path: '/test', params: {} }),
      mapResource: (r) => ({ teamtailor_id: r.id }),
      upsert: async () => {
        throw new Error('boom');
      },
    };

    await expect(
      runIncremental(failingSyncer, {
        db: {} as SyncerDeps['db'],
        client: fakeClient(3),
      } as SyncerDeps),
    ).rejects.toThrow('boom');

    const outcome = vi.mocked(releaseLock).mock.calls[0]?.[2];
    expect(outcome?.status).toBe('error');
    if (outcome?.status === 'error') {
      // Error outcome shape has no `lastCursor` field — invariant
      // preserved: error path NEVER touches the cursor.
      expect(Object.prototype.hasOwnProperty.call(outcome, 'lastCursor')).toBe(false);
      expect(outcome.lastSyncedAt).toBe('2026-04-26T00:00:00.000Z');
    }
  });
});
