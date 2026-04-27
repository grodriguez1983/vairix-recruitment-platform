/**
 * CLI entry point for backfill — re-syncs an entity (or all of them)
 * **ignoring the persisted cursor** (ADR-028). Resets
 * `sync_state.last_cursor` and `sync_state.last_synced_at` to NULL
 * before invoking `runIncremental`, so the next run hits Teamtailor
 * without `filter[updated-at][from]` and walks every page from the
 * start.
 *
 * Usage:
 *   pnpm sync:backfill --entity=<name>
 *   pnpm sync:backfill --entity=all
 *
 * Same env vars as `sync-incremental` (see that file). Additionally:
 *   - SYNC_MAX_RECORDS    (optional) — applied to every entity
 *   - SYNC_SCOPE_BY_CANDIDATES (optional) — applied to child syncers
 *
 * Operación Tier 2 (`docs/operation-classification.md`). El gate
 * humano vive en `.github/workflows/backfill.yml` (input `confirm`);
 * cuando se corre local, el operador asume responsabilidad.
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error (missing/unknown --entity)
 *   2 — configuration error (missing env var, unknown entity in
 *       sync_state)
 *   3 — lock busy (another run active)
 *   4 — fatal sync error (TT down, upsert failure, reset failure, etc.)
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { LockBusyError, SyncError, UnknownEntityError } from '../lib/sync/errors';
import { runIncremental, type EntitySyncer } from '../lib/sync/run';
import {
  buildSyncers,
  buildTeamtailorClient,
  loadScopeCandidateTtIds,
  parseBoolEnv,
  parseIntEnv,
  parseOptionalPositiveInt,
  requireEnv,
  resetCursor,
} from '../lib/sync/cli';
import {
  CANONICAL_ENTITY_ORDER,
  parseBackfillArgs,
  runOrchestration,
} from '../lib/sync/orchestration';
import type { TeamtailorClient } from '../lib/teamtailor/client';

interface RunDeps {
  db: SupabaseClient;
  client: TeamtailorClient;
  syncers: Record<string, EntitySyncer<unknown>>;
  maxRecords: number | undefined;
  scopeByCandidates: boolean;
}

/**
 * Resets the cursor for `entity`, then runs `runIncremental`. The
 * scope set is re-read inside this function so when invoked from the
 * `--entity=all` path it picks up candidates upserted earlier in the
 * orchestration (matching `sync:full` semantics, ADR-028).
 */
async function backfillEntity(
  deps: RunDeps,
  entity: string,
): Promise<{
  entity: string;
  recordsSynced: number;
}> {
  const syncer = deps.syncers[entity];
  if (!syncer) {
    throw new Error(`no syncer registered for entity "${entity}"`);
  }

  await resetCursor(deps.db, entity);
  // eslint-disable-next-line no-console
  console.log(`[sync:backfill] ${entity}: cursor reset, starting full re-fetch`);

  let scopeCandidateTtIds: Set<string> | undefined;
  if (deps.scopeByCandidates) {
    scopeCandidateTtIds = await loadScopeCandidateTtIds(deps.db);
    // eslint-disable-next-line no-console
    console.log(
      `[sync:backfill] ${entity}: scope-by-candidates ${scopeCandidateTtIds.size} ids in scope`,
    );
  }

  const result = await runIncremental(syncer, {
    db: deps.db,
    client: deps.client,
    ...(deps.maxRecords !== undefined ? { maxRecords: deps.maxRecords } : {}),
    ...(scopeCandidateTtIds !== undefined ? { scopeCandidateTtIds } : {}),
  });
  // eslint-disable-next-line no-console
  console.log(
    `[sync:backfill] ${entity} done: ${result.recordsSynced} records, ${result.rowErrors} row errors`,
  );
  return { entity: result.entity, recordsSynced: result.recordsSynced };
}

async function main(): Promise<void> {
  let parsed: { entity: string };
  try {
    parsed = parseBackfillArgs(process.argv.slice(2));
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`[sync:backfill] usage error: ${msg}`);
    console.error(
      `[sync:backfill] usage: pnpm sync:backfill --entity=<${[...CANONICAL_ENTITY_ORDER, 'all'].join('|')}>`,
    );
    process.exit(1);
  }

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
  const ttToken = requireEnv('TEAMTAILOR_API_TOKEN');
  const ttVersion = requireEnv('TEAMTAILOR_API_VERSION');
  const ttBaseUrl = requireEnv('TEAMTAILOR_BASE_URL');

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const client = buildTeamtailorClient({
    apiKey: ttToken,
    apiVersion: ttVersion,
    baseUrl: ttBaseUrl,
    tokensPerSecond: parseIntEnv('TEAMTAILOR_RATE_TOKENS_PER_SECOND', 4),
    burst: parseIntEnv('TEAMTAILOR_RATE_BURST', 10),
  });

  const deps: RunDeps = {
    db,
    client,
    syncers: buildSyncers(db),
    maxRecords: parseOptionalPositiveInt('SYNC_MAX_RECORDS'),
    scopeByCandidates: parseBoolEnv('SYNC_SCOPE_BY_CANDIDATES'),
  };

  if (parsed.entity === 'all') {
    // eslint-disable-next-line no-console
    console.log(
      `[sync:backfill] orchestrating ${CANONICAL_ENTITY_ORDER.length} entities (cursor reset per entity)`,
    );
    try {
      const outcome = await runOrchestration({
        entities: CANONICAL_ENTITY_ORDER,
        runOne: (entity) => backfillEntity(deps, entity),
      });
      // eslint-disable-next-line no-console
      console.log(
        `[sync:backfill] completed ${outcome.results.length}/${CANONICAL_ENTITY_ORDER.length}: ${outcome.results
          .map((r) => `${r.entity}=${r.recordsSynced}`)
          .join(' ')}`,
      );
      process.exit(0);
    } catch (e) {
      // The orchestrator wraps the underlying error with the failing
      // entity's name. Cause carries the original type so exit-code
      // routing matches `sync-incremental`.
      const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
      const wrappedMsg = e instanceof Error ? e.message : String(e);
      if (cause instanceof LockBusyError) {
        console.warn(`[sync:backfill] aborted — ${wrappedMsg}`);
        process.exit(3);
      }
      if (cause instanceof UnknownEntityError) {
        console.error(`[sync:backfill] aborted — ${wrappedMsg}`);
        process.exit(2);
      }
      if (cause instanceof SyncError) {
        console.error(`[sync:backfill] aborted — ${wrappedMsg}`, cause.context);
        process.exit(4);
      }
      console.error(`[sync:backfill] aborted —`, e);
      process.exit(4);
    }
    return;
  }

  // Single entity path.
  try {
    const result = await backfillEntity(deps, parsed.entity);
    // eslint-disable-next-line no-console
    console.log(
      `[sync:backfill] ${result.entity} backfill complete: ${result.recordsSynced} records`,
    );
    process.exit(0);
  } catch (e) {
    if (e instanceof LockBusyError) {
      console.warn(
        `[sync:backfill] ${parsed.entity} skipped: lock busy since ${e.lastRunStartedAt}`,
      );
      process.exit(3);
    }
    if (e instanceof UnknownEntityError) {
      console.error(`[sync:backfill] ${parsed.entity} has no sync_state row (run migrations?)`);
      process.exit(2);
    }
    if (e instanceof SyncError) {
      console.error(`[sync:backfill] ${parsed.entity} fatal: ${e.message}`, e.context);
      process.exit(4);
    }
    console.error(`[sync:backfill] ${parsed.entity} unexpected error:`, e);
    process.exit(4);
  }
}

void main();
