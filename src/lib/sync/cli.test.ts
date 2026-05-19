/**
 * Pin invariant from ADR-028 §"Lista canónica como dato": every
 * entity in `CANONICAL_ENTITY_ORDER` must have a syncer in the
 * registry, and vice versa. Without this test, adding a syncer (or
 * renaming one) without updating the canonical order would silently
 * drop it from `sync:full` / `sync:backfill --entity=all`.
 */
import { describe, expect, it, vi } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildSyncers, sealCursor } from './cli';
import { CANONICAL_ENTITY_ORDER } from './orchestration';

function fakeDb(): SupabaseClient {
  return {
    storage: { from: () => ({}) },
  } as unknown as SupabaseClient;
}

describe('buildSyncers', () => {
  it('test_keys_match_canonical_entity_order_set', () => {
    const keys = new Set(Object.keys(buildSyncers(fakeDb())));
    const canonical = new Set(CANONICAL_ENTITY_ORDER);
    expect(keys).toEqual(canonical);
  });

  it('test_each_syncer_declares_entity_matching_its_registry_key', () => {
    // Catches "registered under wrong key" misconfigs (e.g. registry
    // key 'evaluations' but syncer.entity is 'interviews').
    const syncers = buildSyncers(fakeDb());
    for (const [key, syncer] of Object.entries(syncers)) {
      expect(syncer.entity, `registry[${key}]`).toBe(key);
    }
  });
});

// ─────────────────────────────────────────────────────────────────
// sealCursor — used by `sync:backfill --seal-cursor` to mark the
// incremental watermark as "current" after a date-window backfill
// finished re-ingesting history. Pure DB write, no TT call.
// ─────────────────────────────────────────────────────────────────

interface CapturedUpdate {
  table: string;
  payload: Record<string, unknown>;
  filter: { column: string; value: string };
}

function dbCapturingUpdates(captured: CapturedUpdate[]): SupabaseClient {
  return {
    from: (table: string) => ({
      update: (payload: Record<string, unknown>) => ({
        eq: async (column: string, value: string) => {
          captured.push({ table, payload, filter: { column, value } });
          return { error: null };
        },
      }),
    }),
  } as unknown as SupabaseClient;
}

describe('sealCursor', () => {
  it('test_writes_last_cursor_and_last_synced_at_to_provided_iso', async () => {
    const captured: CapturedUpdate[] = [];
    const db = dbCapturingUpdates(captured);

    await sealCursor(db, 'candidates', '2026-05-18T20:00:00.000Z');

    expect(captured).toHaveLength(1);
    expect(captured[0]!.table).toBe('sync_state');
    expect(captured[0]!.payload).toEqual({
      last_cursor: '2026-05-18T20:00:00.000Z',
      last_synced_at: '2026-05-18T20:00:00.000Z',
    });
    expect(captured[0]!.filter).toEqual({ column: 'entity', value: 'candidates' });
  });

  it('test_propagates_db_error_with_clear_message', async () => {
    const db = {
      from: () => ({
        update: () => ({
          eq: async () => ({ error: { message: 'permission denied' } }),
        }),
      }),
    } as unknown as SupabaseClient;
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`exit:${code}`);
    }) as never);
    await expect(sealCursor(db, 'candidates', '2026-05-18T20:00:00.000Z')).rejects.toThrow(
      /exit:4/,
    );
    exit.mockRestore();
  });
});
