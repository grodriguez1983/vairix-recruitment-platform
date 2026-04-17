/**
 * Advisory lock over `sync_state` for ETL runs.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

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

export async function acquireLock(
  _db: SupabaseClient,
  _entity: string,
  _opts?: AcquireLockOptions,
): Promise<SyncStateRow> {
  throw new Error('acquireLock: not implemented');
}

export async function releaseLock(
  _db: SupabaseClient,
  _entity: string,
  _outcome: ReleaseOutcome,
  _opts?: ReleaseLockOptions,
): Promise<void> {
  throw new Error('releaseLock: not implemented');
}

export async function readSyncState(_db: SupabaseClient, _entity: string): Promise<SyncStateRow> {
  throw new Error('readSyncState: not implemented');
}
