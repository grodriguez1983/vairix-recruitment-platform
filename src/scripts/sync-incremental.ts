/**
 * CLI entry point for incremental sync.
 *
 * Usage:
 *   pnpm sync:incremental <entity>
 *
 * Requires the following env vars (see .env.example):
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - TEAMTAILOR_API_TOKEN
 *   - TEAMTAILOR_API_VERSION
 *   - TEAMTAILOR_BASE_URL
 *   - TEAMTAILOR_RATE_TOKENS_PER_SECOND (optional, default 4)
 *   - TEAMTAILOR_RATE_BURST              (optional, default 10)
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error (unknown entity, missing arg)
 *   2 — configuration error (missing env var)
 *   3 — lock busy (another run active)
 *   4 — fatal sync error (TT down, upsert failure, etc.)
 */
import { createClient } from '@supabase/supabase-js';

import { LockBusyError, SyncError, UnknownEntityError } from '../lib/sync/errors';
import { runIncremental } from '../lib/sync/run';
import {
  buildSyncers,
  buildTeamtailorClient,
  loadScopeCandidateTtIds,
  parseBoolEnv,
  parseIntEnv,
  parseOptionalPositiveInt,
  requireEnv,
} from '../lib/sync/cli';

async function main(): Promise<void> {
  const entity = process.argv[2];

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
  const ttToken = requireEnv('TEAMTAILOR_API_TOKEN');
  const ttVersion = requireEnv('TEAMTAILOR_API_VERSION');
  const ttBaseUrl = requireEnv('TEAMTAILOR_BASE_URL');

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const syncers = buildSyncers(db);

  if (!entity) {
    console.error('[sync] usage: pnpm sync:incremental <entity>');
    console.error(`[sync] available entities: ${Object.keys(syncers).join(', ')}`);
    process.exit(1);
  }
  const syncer = syncers[entity];
  if (!syncer) {
    console.error(`[sync] unknown entity: ${entity}`);
    console.error(`[sync] available entities: ${Object.keys(syncers).join(', ')}`);
    process.exit(1);
  }

  const client = buildTeamtailorClient({
    apiKey: ttToken,
    apiVersion: ttVersion,
    baseUrl: ttBaseUrl,
    tokensPerSecond: parseIntEnv('TEAMTAILOR_RATE_TOKENS_PER_SECOND', 4),
    burst: parseIntEnv('TEAMTAILOR_RATE_BURST', 10),
  });

  const maxRecords = parseOptionalPositiveInt('SYNC_MAX_RECORDS');
  const scopeByCandidates = parseBoolEnv('SYNC_SCOPE_BY_CANDIDATES');
  let scopeCandidateTtIds: Set<string> | undefined;
  if (scopeByCandidates) {
    scopeCandidateTtIds = await loadScopeCandidateTtIds(db);
    // eslint-disable-next-line no-console
    console.log(
      `[sync] scope-by-candidates enabled: ${scopeCandidateTtIds.size} teamtailor_ids in scope`,
    );
  }

  try {
    const result = await runIncremental(syncer, {
      db,
      client,
      ...(maxRecords !== undefined ? { maxRecords } : {}),
      ...(scopeCandidateTtIds !== undefined ? { scopeCandidateTtIds } : {}),
    });
    // CLI success output; `no-console` is off here because this is a
    // script, not a library module.
    // eslint-disable-next-line no-console
    console.log(
      `[sync] ${result.entity} done: ${result.recordsSynced} records, ${result.rowErrors} row errors, run_started_at=${result.runStartedAt}`,
    );
    process.exit(0);
  } catch (e) {
    if (e instanceof LockBusyError) {
      console.warn(`[sync] ${entity} skipped: lock busy since ${e.lastRunStartedAt}`);
      process.exit(3);
    }
    if (e instanceof UnknownEntityError) {
      console.error(`[sync] ${entity} has no sync_state row (run migrations?)`);
      process.exit(2);
    }
    if (e instanceof SyncError) {
      console.error(`[sync] ${entity} fatal: ${e.message}`, e.context);
      process.exit(4);
    }
    console.error(`[sync] ${entity} unexpected error:`, e);
    process.exit(4);
  }
}

void main();
