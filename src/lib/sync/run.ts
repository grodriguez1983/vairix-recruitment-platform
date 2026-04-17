/**
 * Generic incremental sync loop.
 *
 * Stub — implementación en [GREEN] siguiente.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { TeamtailorClient } from '../teamtailor/client';
import type { TTParsedResource } from '../teamtailor/types';

export interface SyncerDeps {
  /** Service-role Supabase client (bypasses RLS). */
  db: SupabaseClient;
  /** Configured Teamtailor client. */
  client: TeamtailorClient;
  /** Clock for timestamp generation in tests. */
  now?: () => number;
  /** Minimal logger. Falls back to no-op. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
}

/**
 * Contract every per-entity syncer implements. The generic `runIncremental`
 * composes these steps with the lock + sync_errors machinery.
 */
export interface EntitySyncer<Row = unknown> {
  /** Must match the row in `sync_state.entity`. */
  entity: string;
  /**
   * Returns the initial HTTP request for this entity given the last
   * cursor (or null if there's no prior sync).
   */
  buildInitialRequest(cursor: string | null): { path: string; params?: Record<string, string> };
  /**
   * Maps a single parsed TT resource to an internal DB row. Throws
   * if the resource is unmappable — the runner catches this as a
   * row-level error (logged to sync_errors) and continues the batch.
   */
  mapResource(resource: TTParsedResource): Row;
  /**
   * Upserts a batch of rows. Failure is treated as FATAL by the
   * runner: the lock releases with status='error' and
   * last_synced_at does NOT advance.
   */
  upsert(rows: Row[], deps: SyncerDeps): Promise<number>;
}

export interface RunIncrementalResult {
  entity: string;
  recordsSynced: number;
  runStartedAt: string;
  rowErrors: number;
}

export async function runIncremental<Row>(
  _syncer: EntitySyncer<Row>,
  _deps: SyncerDeps,
): Promise<RunIncrementalResult> {
  throw new Error('runIncremental: not implemented');
}
