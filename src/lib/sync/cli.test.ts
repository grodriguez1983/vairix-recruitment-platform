/**
 * Pin invariant from ADR-028 §"Lista canónica como dato": every
 * entity in `CANONICAL_ENTITY_ORDER` must have a syncer in the
 * registry, and vice versa. Without this test, adding a syncer (or
 * renaming one) without updating the canonical order would silently
 * drop it from `sync:full` / `sync:backfill --entity=all`.
 */
import { describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { buildSyncers } from './cli';
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
