/**
 * CLI entry point for full sync — orchestrates `runIncremental` over
 * every entity in `CANONICAL_ENTITY_ORDER` (ADR-028). Still
 * incremental in the sense that the persisted `last_cursor`
 * (ADR-027) keeps each entity bounded to its delta — `sync:full` is
 * "all entities", not "ignore the watermark". For a true watermark
 * reset use `sync:backfill --entity=all`.
 *
 * Usage:
 *   pnpm sync:full
 *
 * Same env vars as `sync-incremental` (see that file). Additionally:
 *   - SYNC_MAX_RECORDS    (optional) — applied to every entity
 *   - SYNC_SCOPE_BY_CANDIDATES (optional) — applied to child syncers
 *
 * Exit codes:
 *   0 — every entity succeeded
 *   2 — configuration error
 *   3 — lock busy on one of the entities (rest skipped)
 *   4 — fatal sync error on one of the entities (rest skipped)
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
} from '../lib/sync/cli';
import { CANONICAL_ENTITY_ORDER, runOrchestration } from '../lib/sync/orchestration';
import type { TeamtailorClient } from '../lib/teamtailor/client';

interface RunDeps {
  db: SupabaseClient;
  client: TeamtailorClient;
  syncers: Record<string, EntitySyncer<unknown>>;
  maxRecords: number | undefined;
  scopeByCandidates: boolean;
}

/**
 * Runs a single entity. Re-reads `scopeCandidateTtIds` from DB at
 * call time so the set picks up any candidates upserted by an
 * earlier entity in the same orchestration (ADR-028 §"sync:full /
 * Env vars respetados").
 */
async function runEntity(
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

  let scopeCandidateTtIds: Set<string> | undefined;
  if (deps.scopeByCandidates) {
    scopeCandidateTtIds = await loadScopeCandidateTtIds(deps.db);
    // eslint-disable-next-line no-console
    console.log(
      `[sync:full] ${entity}: scope-by-candidates ${scopeCandidateTtIds.size} ids in scope`,
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
    `[sync:full] ${entity} done: ${result.recordsSynced} records, ${result.rowErrors} row errors`,
  );
  return { entity: result.entity, recordsSynced: result.recordsSynced };
}

async function main(): Promise<void> {
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

  // eslint-disable-next-line no-console
  console.log(`[sync:full] orchestrating ${CANONICAL_ENTITY_ORDER.length} entities`);

  try {
    const outcome = await runOrchestration({
      entities: CANONICAL_ENTITY_ORDER,
      runOne: (entity) => runEntity(deps, entity),
    });
    // eslint-disable-next-line no-console
    console.log(
      `[sync:full] completed ${outcome.results.length}/${CANONICAL_ENTITY_ORDER.length}: ${outcome.results
        .map((r) => `${r.entity}=${r.recordsSynced}`)
        .join(' ')}`,
    );
    process.exit(0);
  } catch (e) {
    // The orchestrator wraps the underlying error with the failing
    // entity's name. The actual cause carries the original type so
    // the same exit-code routing as `sync-incremental` applies.
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause : e;
    const wrappedMsg = e instanceof Error ? e.message : String(e);
    if (cause instanceof LockBusyError) {
      console.warn(`[sync:full] aborted — ${wrappedMsg}`);
      process.exit(3);
    }
    if (cause instanceof UnknownEntityError) {
      console.error(`[sync:full] aborted — ${wrappedMsg}`);
      process.exit(2);
    }
    if (cause instanceof SyncError) {
      console.error(`[sync:full] aborted — ${wrappedMsg}`, cause.context);
      process.exit(4);
    }
    console.error(`[sync:full] aborted —`, e);
    process.exit(4);
  }
}

void main();
