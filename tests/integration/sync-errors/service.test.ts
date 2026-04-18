/**
 * Integration tests for the sync-errors admin service (F2-004).
 *
 * Covers: list + filters (entity, resolved state) + pagination,
 * count, resolveSyncError lifecycle.
 *
 * Uses service-role client: the admin panel itself runs with the
 * user's JWT + role=admin (RLS gate), but tests seed + assert rows
 * directly. Admin-role RLS behavior is already covered in
 * `tests/rls/sync_errors.test.ts`.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  countSyncErrors,
  listSyncErrors,
  resolveSyncError,
} from '../../../src/lib/sync-errors/service';
import { SyncErrorAdminError } from '../../../src/lib/sync-errors/errors';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const db = svc();
const PREFIX = 'syncerrtest-';

async function cleanup(): Promise<void> {
  await db.from('sync_errors').delete().like('teamtailor_id', `${PREFIX}%`);
}

async function seed(): Promise<string[]> {
  await cleanup();
  const runStarted = new Date().toISOString();
  const { data, error } = await db
    .from('sync_errors')
    .insert([
      {
        entity: 'candidates',
        teamtailor_id: `${PREFIX}c1`,
        error_code: 'map_error',
        error_message: 'missing email',
        payload: { attrs: { id: 'tt-c1' } },
        run_started_at: runStarted,
      },
      {
        entity: 'candidates',
        teamtailor_id: `${PREFIX}c2`,
        error_code: 'upsert_conflict',
        error_message: 'duplicate email',
        payload: {},
        run_started_at: runStarted,
        resolved_at: new Date().toISOString(),
      },
      {
        entity: 'applications',
        teamtailor_id: `${PREFIX}a1`,
        error_code: 'fk_unresolved',
        error_message: 'job not found for tt_id tt-job-42',
        payload: {},
        run_started_at: runStarted,
      },
    ])
    .select('id, teamtailor_id')
    .order('teamtailor_id', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => r.id as string);
}

describe('sync-errors service', () => {
  afterAll(cleanup);

  let ids: string[];

  beforeEach(async () => {
    ids = await seed();
  });

  it('listSyncErrors: unresolved-only by default', async () => {
    const rows = await listSyncErrors(db, { limit: 50, teamtailorIdPrefix: PREFIX });
    // Only c1 and a1 are unresolved (c2 is resolved).
    expect(rows.map((r) => r.teamtailor_id)).toEqual(
      expect.arrayContaining([`${PREFIX}c1`, `${PREFIX}a1`]),
    );
    expect(rows.find((r) => r.teamtailor_id === `${PREFIX}c2`)).toBeUndefined();
    expect(rows.length).toBe(2);
  });

  it('listSyncErrors: filter by entity', async () => {
    const rows = await listSyncErrors(db, {
      entity: 'applications',
      limit: 50,
      teamtailorIdPrefix: PREFIX,
    });
    expect(rows.length).toBe(1);
    expect(rows[0]?.teamtailor_id).toBe(`${PREFIX}a1`);
  });

  it('listSyncErrors: includeResolved=true returns resolved rows too', async () => {
    const rows = await listSyncErrors(db, {
      includeResolved: true,
      limit: 50,
      teamtailorIdPrefix: PREFIX,
    });
    expect(rows.length).toBe(3);
  });

  it('listSyncErrors: pagination with limit + offset', async () => {
    const first = await listSyncErrors(db, {
      limit: 1,
      offset: 0,
      includeResolved: true,
      teamtailorIdPrefix: PREFIX,
    });
    const second = await listSyncErrors(db, {
      limit: 1,
      offset: 1,
      includeResolved: true,
      teamtailorIdPrefix: PREFIX,
    });
    expect(first.length).toBe(1);
    expect(second.length).toBe(1);
    expect(first[0]?.id).not.toBe(second[0]?.id);
  });

  it('countSyncErrors: returns counts for unresolved vs all', async () => {
    const unresolved = await countSyncErrors(db, { teamtailorIdPrefix: PREFIX });
    expect(unresolved).toBe(2);

    const all = await countSyncErrors(db, { includeResolved: true, teamtailorIdPrefix: PREFIX });
    expect(all).toBe(3);
  });

  it('resolveSyncError: sets resolved_at on an unresolved row', async () => {
    const target = ids[0]!; // c1 (sorted alphabetically; c1 comes before a1? no — a1 < c1)
    // sort was by teamtailor_id ascending: [a1, c1, c2]
    await resolveSyncError(db, target);
    const { data } = await db
      .from('sync_errors')
      .select('resolved_at')
      .eq('id', target)
      .maybeSingle();
    expect(data?.resolved_at).not.toBeNull();
  });

  it('resolveSyncError: throws not_found for unknown id', async () => {
    await expect(
      resolveSyncError(db, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(SyncErrorAdminError);
  });

  it('resolveSyncError: throws already_resolved when run twice', async () => {
    const target = ids[0]!;
    await resolveSyncError(db, target);
    await expect(resolveSyncError(db, target)).rejects.toMatchObject({
      code: 'already_resolved',
    });
  });
});
