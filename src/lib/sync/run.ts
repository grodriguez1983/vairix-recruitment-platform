/**
 * Generic incremental sync loop.
 *
 * Flow:
 *   1. acquireLock() — aborts if another run is active (LockBusyError).
 *   2. Iterate paginate(entity) from the Teamtailor client. For each
 *      resource, mapResource() → Row. Mapping failures are row-level:
 *      logged to `sync_errors`, batch continues.
 *   3. When the batch reaches BATCH_SIZE, call syncer.upsert(). Upsert
 *      failure is FATAL: release lock with status='error' and leave
 *      `last_synced_at` pinned to the previous watermark.
 *   4. On success, release lock with the run-start timestamp as the
 *      new watermark and the total records synced.
 *
 * Cursor semantics: we use `last_run_started` (captured at acquire
 * time) as the next watermark. This guarantees monotonicity under
 * clock skew scenarios better than `now()` at release time (though
 * in practice both work for stages).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { TeamtailorClient } from '../teamtailor/client';
import type { TTParsedResource } from '../teamtailor/types';
import { acquireLock, releaseLock } from './lock';
import { SyncError } from './errors';

const BATCH_SIZE = 50;

export interface SyncerDeps {
  /** Service-role Supabase client (bypasses RLS). */
  db: SupabaseClient;
  /** Configured Teamtailor client. */
  client: TeamtailorClient;
  /** Clock for timestamp generation in tests. */
  now?: () => number;
  /** Minimal logger. Falls back to no-op. */
  logger?: Pick<Console, 'info' | 'warn' | 'error'>;
  /**
   * Hard cap on resources consumed from Teamtailor in this run. When
   * set, pagination stops after this many resources have been yielded
   * (regardless of whether they map successfully). Undefined = drain
   * every page. Intended for smoke-test seeding — production
   * incremental runs should leave this unset.
   */
  maxRecords?: number;
  /**
   * Scope filter for child syncers (applications, notes, interviews,
   * uploads). When present, rows whose `candidate_tt_id` is not in
   * this set are silently skipped during upsert — no `sync_errors`
   * entry is written. Intended for partial backfills seeded by a
   * capped `candidates` run; the set should be the teamtailor_ids of
   * the candidates already present locally. Undefined = preserve the
   * default behavior (unresolved candidate → orphan log).
   */
  scopeCandidateTtIds?: ReadonlySet<string>;
}

export interface EntitySyncer<Row = unknown> {
  /** Must match the row in `sync_state.entity`. */
  entity: string;
  /**
   * When true, the runner iterates pages via
   * `client.paginateWithIncluded()` so `mapResource()` receives the
   * sideloaded `included` array alongside the primary resource. When
   * false/omitted, the runner uses the simpler `paginate()` path and
   * the second arg is `[]`. See ADR-010 §2.
   */
  includesSideloads?: boolean;
  /**
   * Returns the initial HTTP request for this entity given the last
   * cursor (or null if there's no prior sync).
   */
  buildInitialRequest(cursor: string | null): { path: string; params?: Record<string, string> };
  /**
   * Maps a single parsed TT resource to an internal DB row. Throws
   * if the resource is unmappable — the runner catches this as a
   * row-level error (logged to sync_errors) and continues the batch.
   *
   * `included` is the JSON:API sideloaded resources from the same
   * page (only populated when `includesSideloads=true`, otherwise []).
   */
  mapResource(resource: TTParsedResource, included: TTParsedResource[]): Row;
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

async function recordRowError(
  db: SupabaseClient,
  params: {
    entity: string;
    teamtailorId: string | null;
    error: unknown;
    payload: unknown;
    runStartedAt: string;
  },
): Promise<void> {
  const errCode = params.error instanceof Error ? params.error.name : 'UnknownError';
  const errMsg = params.error instanceof Error ? params.error.message : String(params.error);
  const { error } = await db.from('sync_errors').insert({
    entity: params.entity,
    teamtailor_id: params.teamtailorId,
    error_code: errCode,
    error_message: errMsg,
    payload: params.payload as Record<string, unknown>,
    run_started_at: params.runStartedAt,
  });
  // If we can't record the row error, surface it as fatal — the
  // runner's outer try/catch will release the lock with error.
  if (error) {
    throw new SyncError('failed to write sync_errors row', {
      entity: params.entity,
      cause: error.message,
    });
  }
}

export async function runIncremental<Row>(
  syncer: EntitySyncer<Row>,
  deps: SyncerDeps,
): Promise<RunIncrementalResult> {
  const logger = deps.logger ?? console;
  const acquired = await acquireLock(deps.db, syncer.entity);
  const runStartedAt = acquired.lastRunStartedAt!;
  const priorWatermark = acquired.lastSyncedAt;
  // ADR-027: `last_cursor` is the per-entity watermark used by
  // `buildInitialRequest`. For rows persisted before ADR-027,
  // `last_cursor` is null while `last_synced_at` already carries the
  // right value — use it as a one-shot fallback so the first
  // post-fix run is genuinely incremental instead of a full scan.
  const cursor = acquired.lastCursor ?? acquired.lastSyncedAt;

  let recordsSynced = 0;
  let rowErrors = 0;

  try {
    const { path, params } = syncer.buildInitialRequest(cursor);
    const batch: Row[] = [];

    const pushOrRecord = async (
      resource: TTParsedResource,
      included: TTParsedResource[],
    ): Promise<void> => {
      try {
        const row = syncer.mapResource(resource, included);
        batch.push(row);
      } catch (e) {
        rowErrors += 1;
        await recordRowError(deps.db, {
          entity: syncer.entity,
          teamtailorId: resource.id ?? null,
          error: e,
          payload: resource,
          runStartedAt,
        });
        return;
      }
      if (batch.length >= BATCH_SIZE) {
        recordsSynced += await syncer.upsert(batch.splice(0, batch.length), deps);
      }
    };

    const cap = deps.maxRecords ?? Infinity;
    let yielded = 0;
    if (syncer.includesSideloads) {
      for await (const { resource, included } of deps.client.paginateWithIncluded(path, params)) {
        await pushOrRecord(resource, included);
        yielded += 1;
        if (yielded >= cap) break;
      }
    } else {
      for await (const resource of deps.client.paginate(path, params)) {
        await pushOrRecord(resource, []);
        yielded += 1;
        if (yielded >= cap) break;
      }
    }
    if (batch.length > 0) {
      recordsSynced += await syncer.upsert(batch, deps);
    }

    await releaseLock(deps.db, syncer.entity, {
      status: 'success',
      recordsSynced,
      lastSyncedAt: runStartedAt,
      // ADR-027: persist run-start as the next cursor so subsequent
      // runs filter by `updated-at >= cursor` and stop full-scanning
      // Teamtailor.
      lastCursor: runStartedAt,
    });
    logger.info?.(
      `[sync] ${syncer.entity} success: ${recordsSynced} records, ${rowErrors} row errors`,
    );
    return { entity: syncer.entity, recordsSynced, runStartedAt, rowErrors };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    await releaseLock(deps.db, syncer.entity, {
      status: 'error',
      error: message,
      lastSyncedAt: priorWatermark,
    });
    logger.error?.(`[sync] ${syncer.entity} failed: ${message}`);
    throw e;
  }
}
