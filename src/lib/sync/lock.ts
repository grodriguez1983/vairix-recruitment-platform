/**
 * Advisory lock over `sync_state` for ETL runs.
 *
 * The lock is a conditional UPDATE on the sync_state row:
 *   flip status→'running' iff the row is NOT in an active run
 *   (i.e. status != 'running' OR started more than stale_timeout
 *   minutes ago).
 *
 * Because Postgres serializes UPDATE statements on the same row under
 * READ COMMITTED, two concurrent acquireLock() calls cannot both
 * flip the status — the loser re-reads the row, sees status='running'
 * with a fresh started_at, and its WHERE clause fails (no row
 * matched). We surface that as `LockBusyError`.
 *
 * On release, we NEVER advance `last_synced_at` on error paths. The
 * caller MUST pass back the previous watermark explicitly (or null)
 * so a failed run restarts from the same cursor next cycle.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { LockBusyError, SyncError, UnknownEntityError } from './errors';

export interface AcquireLockOptions {
  /** Clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export interface SyncStateRow {
  entity: string;
  lastRunStatus: 'idle' | 'running' | 'success' | 'error' | null;
  lastRunStartedAt: string | null;
  lastRunFinishedAt: string | null;
  lastSyncedAt: string | null;
  lastCursor: string | null;
  recordsSynced: number | null;
  staleTimeoutMinutes: number | null;
}

export interface ReleaseLockOptions {
  /** Clock for tests. Defaults to Date.now. */
  now?: () => number;
}

export type ReleaseOutcome =
  | {
      status: 'success';
      recordsSynced: number;
      /** Watermark to persist as `last_synced_at`. Usually run start. */
      lastSyncedAt: string;
      /** Optional incremental cursor (e.g. Teamtailor updated-at). */
      lastCursor?: string | null;
    }
  | {
      status: 'error';
      error: string;
      /** On error, `last_synced_at` MUST NOT advance — caller passes
       *  the previous value explicitly (or null) so it remains pinned. */
      lastSyncedAt: string | null;
    };

/** Raw row shape straight from supabase-js (snake_case). */
interface DbRow {
  entity: string;
  last_run_status: string | null;
  last_run_started: string | null;
  last_run_finished: string | null;
  last_synced_at: string | null;
  last_cursor: string | null;
  records_synced: number | null;
  stale_timeout_minutes: number | null;
}

function toSyncStateRow(row: DbRow): SyncStateRow {
  return {
    entity: row.entity,
    lastRunStatus: (row.last_run_status as SyncStateRow['lastRunStatus']) ?? null,
    lastRunStartedAt: row.last_run_started,
    lastRunFinishedAt: row.last_run_finished,
    lastSyncedAt: row.last_synced_at,
    lastCursor: row.last_cursor,
    recordsSynced: row.records_synced,
    staleTimeoutMinutes: row.stale_timeout_minutes,
  };
}

/**
 * Attempts to acquire the lock for `entity`.
 *
 * Steps:
 *  1. Read `stale_timeout_minutes` from the row (defaults to 60).
 *  2. Compute the stale threshold relative to `now()`.
 *  3. Conditional UPDATE: succeeds iff status is not 'running' OR
 *     the current run started before the threshold.
 *  4. If no row was updated, distinguish:
 *       - row doesn't exist → UnknownEntityError
 *       - row exists but was busy → LockBusyError
 */
export async function acquireLock(
  db: SupabaseClient,
  entity: string,
  opts?: AcquireLockOptions,
): Promise<SyncStateRow> {
  const nowMs = (opts?.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  // Step 1: read config (stale timeout).
  const { data: existing, error: readErr } = await db
    .from('sync_state')
    .select('stale_timeout_minutes, last_run_status, last_run_started')
    .eq('entity', entity)
    .maybeSingle();

  if (readErr) {
    throw new SyncError('failed to read sync_state', { entity, cause: readErr.message });
  }
  if (!existing) {
    throw new UnknownEntityError(entity);
  }
  const staleMinutes = existing.stale_timeout_minutes ?? 60;
  const staleIso = new Date(nowMs - staleMinutes * 60_000).toISOString();

  // Step 2: conditional update. Match if EITHER:
  //   - status is not 'running' (no active run), OR
  //   - status is 'running' but started before the stale threshold.
  const { data: updated, error: updErr } = await db
    .from('sync_state')
    .update({
      last_run_status: 'running',
      last_run_started: nowIso,
      last_run_finished: null,
      last_run_error: null,
    })
    .eq('entity', entity)
    .or(`last_run_status.neq.running,last_run_started.lt.${staleIso}`)
    .select(
      'entity, last_run_status, last_run_started, last_run_finished, last_synced_at, last_cursor, records_synced, stale_timeout_minutes',
    )
    .maybeSingle();

  if (updErr) {
    throw new SyncError('failed to acquire sync lock', { entity, cause: updErr.message });
  }
  if (!updated) {
    // Row exists (checked in step 1) but WHERE filter rejected the
    // update → another run holds the lock within the stale window.
    throw new LockBusyError(entity, existing.last_run_started ?? 'unknown', {
      staleTimeoutMinutes: staleMinutes,
    });
  }
  return toSyncStateRow(updated as DbRow);
}

/**
 * Finalizes the lock. Regardless of outcome, `last_run_finished` is
 * set to `now()` and `last_run_status` transitions to 'success' or
 * 'error'. On error, `last_synced_at` must remain pinned to the
 * value the caller passes (the previous successful watermark).
 */
export async function releaseLock(
  db: SupabaseClient,
  entity: string,
  outcome: ReleaseOutcome,
  opts?: ReleaseLockOptions,
): Promise<void> {
  const nowMs = (opts?.now ?? Date.now)();
  const nowIso = new Date(nowMs).toISOString();

  const patch: Record<string, unknown> = {
    last_run_finished: nowIso,
    last_run_status: outcome.status,
  };
  if (outcome.status === 'success') {
    patch.last_synced_at = outcome.lastSyncedAt;
    patch.records_synced = outcome.recordsSynced;
    patch.last_run_error = null;
    if (outcome.lastCursor !== undefined) patch.last_cursor = outcome.lastCursor;
  } else {
    // Explicitly re-apply the previous watermark (may be null) so a
    // failed run never "resets" or advances `last_synced_at`.
    patch.last_synced_at = outcome.lastSyncedAt;
    patch.last_run_error = outcome.error;
  }

  const { error } = await db.from('sync_state').update(patch).eq('entity', entity);
  if (error) {
    throw new SyncError('failed to release sync lock', { entity, cause: error.message });
  }
}

/** Reads the current sync_state row (camelCased). */
export async function readSyncState(db: SupabaseClient, entity: string): Promise<SyncStateRow> {
  const { data, error } = await db
    .from('sync_state')
    .select(
      'entity, last_run_status, last_run_started, last_run_finished, last_synced_at, last_cursor, records_synced, stale_timeout_minutes',
    )
    .eq('entity', entity)
    .maybeSingle();
  if (error) {
    throw new SyncError('failed to read sync_state', { entity, cause: error.message });
  }
  if (!data) throw new UnknownEntityError(entity);
  return toSyncStateRow(data as DbRow);
}
