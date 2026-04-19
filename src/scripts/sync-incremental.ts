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
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { TeamtailorClient } from '../lib/teamtailor/client';
import { LockBusyError, SyncError, UnknownEntityError } from '../lib/sync/errors';
import { runIncremental, type EntitySyncer } from '../lib/sync/run';
import { stagesSyncer } from '../lib/sync/stages';
import { usersSyncer } from '../lib/sync/users';
import { jobsSyncer } from '../lib/sync/jobs';
import { customFieldsSyncer } from '../lib/sync/custom-fields';
import { candidatesSyncer } from '../lib/sync/candidates';
import { applicationsSyncer } from '../lib/sync/applications';
import { notesSyncer } from '../lib/sync/notes';
import { interviewsSyncer } from '../lib/sync/interviews';
import { makeUploadsSyncer } from '../lib/sync/uploads';
import { BUCKET as CV_BUCKET } from '../lib/cv/downloader';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[sync] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function parseIntEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[sync] invalid ${name}="${v}" (expected positive number)`);
    process.exit(2);
  }
  return n;
}

function parseOptionalPositiveInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`[sync] invalid ${name}="${v}" (expected positive integer)`);
    process.exit(2);
  }
  return n;
}

function parseBoolEnv(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Partial-backfill helper: reads every `candidates.teamtailor_id`
 * currently in local DB into a Set. Callers pass the result via
 * `SyncerDeps.scopeCandidateTtIds` so child syncers silently drop
 * rows whose candidate is out of scope. For a ~50-candidate smoke
 * test the set is tiny and the query is fast.
 */
async function loadScopeCandidateTtIds(db: SupabaseClient): Promise<Set<string>> {
  const ids = new Set<string>();
  const pageSize = 1000;
  let from = 0;
  for (;;) {
    const { data, error } = await db
      .from('candidates')
      .select('teamtailor_id')
      .not('teamtailor_id', 'is', null)
      .range(from, from + pageSize - 1);
    if (error) {
      console.error(`[sync] failed to load scope candidate tt_ids: ${error.message}`);
      process.exit(4);
    }
    const rows = data ?? [];
    for (const row of rows) {
      if (typeof row.teamtailor_id === 'string') ids.add(row.teamtailor_id);
    }
    if (rows.length < pageSize) break;
    from += pageSize;
  }
  return ids;
}

// The static syncers don't need per-run config. The uploads syncer
// is special: it requires a live Storage bucket client, so it's
// constructed inside main() once `db` exists. We keep entity →
// syncer lookup lazy via a factory.
function buildSyncers(db: SupabaseClient): Record<string, EntitySyncer<unknown>> {
  return {
    stages: stagesSyncer as EntitySyncer<unknown>,
    users: usersSyncer as EntitySyncer<unknown>,
    jobs: jobsSyncer as EntitySyncer<unknown>,
    'custom-fields': customFieldsSyncer as EntitySyncer<unknown>,
    candidates: candidatesSyncer as EntitySyncer<unknown>,
    applications: applicationsSyncer as EntitySyncer<unknown>,
    notes: notesSyncer as EntitySyncer<unknown>,
    // `/v1/interviews` → evaluations + evaluation_answers.
    evaluations: interviewsSyncer as EntitySyncer<unknown>,
    // `/v1/uploads` → files (binary → candidate-cvs bucket).
    files: makeUploadsSyncer({ storage: db.storage.from(CV_BUCKET) }) as EntitySyncer<unknown>,
  };
}

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

  const client = new TeamtailorClient({
    apiKey: ttToken,
    apiVersion: ttVersion,
    baseUrl: ttBaseUrl,
    rateLimit: {
      tokensPerSecond: parseIntEnv('TEAMTAILOR_RATE_TOKENS_PER_SECOND', 4),
      burst: parseIntEnv('TEAMTAILOR_RATE_BURST', 10),
    },
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
