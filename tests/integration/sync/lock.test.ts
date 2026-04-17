/**
 * Integration tests for acquireLock / releaseLock / readSyncState.
 *
 * Runs against the local Supabase stack. Each test starts with the
 * sync_state row for 'stages' reset to idle, then verifies acquire
 * and release transitions, including stale reclaim.
 *
 * We use a separate entity name ('sync_test_stages') to avoid races
 * with the real 'stages' entity that other tests/runs might touch.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { acquireLock, readSyncState, releaseLock } from '../../../src/lib/sync/lock';
import { LockBusyError, UnknownEntityError } from '../../../src/lib/sync/errors';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const ENTITY = 'sync_test_stages';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function seedEntity(
  db: SupabaseClient,
  overrides: Record<string, unknown> = {},
): Promise<void> {
  // Use upsert so tests can run repeatedly.
  const { error } = await db.from('sync_state').upsert(
    {
      entity: ENTITY,
      last_run_status: 'idle',
      last_run_started: null,
      last_run_finished: null,
      last_run_error: null,
      last_synced_at: null,
      last_cursor: null,
      records_synced: 0,
      stale_timeout_minutes: 60,
      ...overrides,
    },
    { onConflict: 'entity' },
  );
  if (error) throw new Error(`seed failed: ${error.message}`);
}

async function cleanupEntity(db: SupabaseClient): Promise<void> {
  await db.from('sync_state').delete().eq('entity', ENTITY);
}

describe('sync_state lock primitives', () => {
  const db = svc();

  beforeEach(async () => {
    await seedEntity(db);
  });

  afterAll(async () => {
    await cleanupEntity(db);
  });

  it('acquires the lock from idle and sets running + started', async () => {
    const row = await acquireLock(db, ENTITY);
    expect(row.lastRunStatus).toBe('running');
    expect(row.lastRunStartedAt).not.toBeNull();
    // Reading back confirms persisted state (no stale in-memory value).
    const persisted = await readSyncState(db, ENTITY);
    expect(persisted.lastRunStatus).toBe('running');
  });

  it('throws LockBusyError when another run is active within the stale window', async () => {
    // Simulate a run that started 5 minutes ago (well inside 60m stale window).
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString();
    await seedEntity(db, { last_run_status: 'running', last_run_started: fiveMinAgo });
    await expect(acquireLock(db, ENTITY)).rejects.toBeInstanceOf(LockBusyError);
  });

  it('reclaims a stale lock whose run started before the timeout', async () => {
    // Pretend the previous run crashed 2 hours ago; stale window = 60 min.
    const twoHoursAgo = new Date(Date.now() - 120 * 60_000).toISOString();
    await seedEntity(db, { last_run_status: 'running', last_run_started: twoHoursAgo });
    const row = await acquireLock(db, ENTITY);
    expect(row.lastRunStatus).toBe('running');
    // And the started timestamp must have advanced (new run, not the zombie's).
    const prev = new Date(twoHoursAgo).getTime();
    const curr = new Date(row.lastRunStartedAt!).getTime();
    expect(curr).toBeGreaterThan(prev);
  });

  it('throws UnknownEntityError when no row exists for the entity', async () => {
    await expect(acquireLock(db, '__does_not_exist__')).rejects.toBeInstanceOf(UnknownEntityError);
  });

  it('release success stamps last_synced_at, records, finished, status=success', async () => {
    const acquired = await acquireLock(db, ENTITY);
    const watermark = acquired.lastRunStartedAt!;
    await releaseLock(db, ENTITY, {
      status: 'success',
      recordsSynced: 42,
      lastSyncedAt: watermark,
      lastCursor: '2026-04-17T00:00:00Z',
    });
    const after = await readSyncState(db, ENTITY);
    expect(after.lastRunStatus).toBe('success');
    expect(after.lastSyncedAt).toBe(watermark);
    expect(after.recordsSynced).toBe(42);
    expect(after.lastRunFinishedAt).not.toBeNull();
    expect(after.lastCursor).toBe('2026-04-17T00:00:00Z');
  });

  it('release error does NOT advance last_synced_at (run remains idempotent)', async () => {
    // Seed a prior successful run with a watermark we must preserve.
    const prior = '2026-04-10T00:00:00.000Z';
    await seedEntity(db, { last_synced_at: prior, records_synced: 7 });
    await acquireLock(db, ENTITY);
    await releaseLock(db, ENTITY, {
      status: 'error',
      error: 'synthetic fatal for test',
      lastSyncedAt: prior, // caller passes previous watermark explicitly
    });
    const after = await readSyncState(db, ENTITY);
    expect(after.lastRunStatus).toBe('error');
    expect(after.lastSyncedAt).toBe(prior);
    expect(after.lastRunFinishedAt).not.toBeNull();
  });
});
