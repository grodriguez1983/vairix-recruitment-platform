/**
 * Admin service for `sync_errors` (F2-004).
 *
 * Stub — implementation lands in the [GREEN] commit.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface SyncErrorRow {
  id: string;
  entity: string;
  teamtailor_id: string | null;
  error_code: string | null;
  error_message: string | null;
  payload: unknown;
  run_started_at: string;
  resolved_at: string | null;
  created_at: string;
}

export interface ListSyncErrorsOptions {
  entity?: string;
  includeResolved?: boolean;
  limit?: number;
  offset?: number;
  /** Test hook: restrict query to rows whose teamtailor_id starts with this. */
  teamtailorIdPrefix?: string;
}

export async function listSyncErrors(
  _db: SupabaseClient,
  _options?: ListSyncErrorsOptions,
): Promise<SyncErrorRow[]> {
  throw new Error('not implemented');
}

export async function countSyncErrors(
  _db: SupabaseClient,
  _options?: { entity?: string; includeResolved?: boolean; teamtailorIdPrefix?: string },
): Promise<number> {
  throw new Error('not implemented');
}

export async function resolveSyncError(_db: SupabaseClient, _id: string): Promise<void> {
  throw new Error('not implemented');
}
