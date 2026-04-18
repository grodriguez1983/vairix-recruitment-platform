/**
 * Admin service for `sync_errors` (F2-004).
 *
 * Small read-mostly layer over `sync_errors` for the admin panel.
 * All writes are admin-only: the RLS policy (see
 * 20260417205213_rls_sync_errors.sql) restricts every operation to
 * `public.current_app_role() = 'admin'`. Service-role bypasses RLS,
 * so tests can seed freely; in the admin route, the caller must be
 * role=admin or the query returns zero rows.
 *
 * The `teamtailorIdPrefix` option exists so integration tests can
 * scope their seed data without colliding with other suites — prod
 * callers pass neither that nor an arbitrary value.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { SyncErrorAdminError } from './errors';

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

const SELECT =
  'id, entity, teamtailor_id, error_code, error_message, payload, run_started_at, resolved_at, created_at';

function applyCommonFilters<T extends { entity?: string; teamtailorIdPrefix?: string }>(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: any,
  options: T,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
): any {
  let q = query;
  if (options.entity) q = q.eq('entity', options.entity);
  if (options.teamtailorIdPrefix) q = q.like('teamtailor_id', `${options.teamtailorIdPrefix}%`);
  return q;
}

export async function listSyncErrors(
  db: SupabaseClient,
  options: ListSyncErrorsOptions = {},
): Promise<SyncErrorRow[]> {
  const { includeResolved = false, limit = 100, offset = 0 } = options;

  let query = db.from('sync_errors').select(SELECT);
  query = applyCommonFilters(query, options);
  if (!includeResolved) query = query.is('resolved_at', null);

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    throw new SyncErrorAdminError('failed to list sync_errors', 'db_error', {
      cause: error.message,
    });
  }
  return (data ?? []) as SyncErrorRow[];
}

export async function countSyncErrors(
  db: SupabaseClient,
  options: { entity?: string; includeResolved?: boolean; teamtailorIdPrefix?: string } = {},
): Promise<number> {
  const { includeResolved = false } = options;

  let query = db.from('sync_errors').select('id', { count: 'exact', head: true });
  query = applyCommonFilters(query, options);
  if (!includeResolved) query = query.is('resolved_at', null);

  const { count, error } = await query;
  if (error) {
    throw new SyncErrorAdminError('failed to count sync_errors', 'db_error', {
      cause: error.message,
    });
  }
  return count ?? 0;
}

export async function resolveSyncError(db: SupabaseClient, id: string): Promise<void> {
  const { data: existing, error: readError } = await db
    .from('sync_errors')
    .select('id, resolved_at')
    .eq('id', id)
    .maybeSingle();
  if (readError) {
    throw new SyncErrorAdminError('failed to read sync_error', 'db_error', {
      cause: readError.message,
    });
  }
  if (!existing) {
    throw new SyncErrorAdminError('sync_error not found', 'not_found', { id });
  }
  if (existing.resolved_at) {
    throw new SyncErrorAdminError('sync_error already resolved', 'already_resolved', { id });
  }

  const { error } = await db
    .from('sync_errors')
    .update({ resolved_at: new Date().toISOString() })
    .eq('id', id);
  if (error) {
    throw new SyncErrorAdminError('failed to resolve sync_error', 'db_error', {
      cause: error.message,
    });
  }
}
