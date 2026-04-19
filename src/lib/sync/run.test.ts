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
