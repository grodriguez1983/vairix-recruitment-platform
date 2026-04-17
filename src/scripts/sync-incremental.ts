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

import { TeamtailorClient } from '../lib/teamtailor/client';
import { LockBusyError, SyncError, UnknownEntityError } from '../lib/sync/errors';
import { runIncremental, type EntitySyncer } from '../lib/sync/run';
import { stagesSyncer } from '../lib/sync/stages';
import { usersSyncer } from '../lib/sync/users';

const SYNCERS: Record<string, EntitySyncer<unknown>> = {
  stages: stagesSyncer as EntitySyncer<unknown>,
  users: usersSyncer as EntitySyncer<unknown>,
  // jobs, candidates, applications, evaluations, notes, files
  // se agregan en el resto de F1-006.
};

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

async function main(): Promise<void> {
  const entity = process.argv[2];
  if (!entity) {
    console.error('[sync] usage: pnpm sync:incremental <entity>');
    console.error(`[sync] available entities: ${Object.keys(SYNCERS).join(', ')}`);
    process.exit(1);
  }
  const syncer = SYNCERS[entity];
  if (!syncer) {
    console.error(`[sync] unknown entity: ${entity}`);
    console.error(`[sync] available entities: ${Object.keys(SYNCERS).join(', ')}`);
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

  const client = new TeamtailorClient({
    apiKey: ttToken,
    apiVersion: ttVersion,
    baseUrl: ttBaseUrl,
    rateLimit: {
      tokensPerSecond: parseIntEnv('TEAMTAILOR_RATE_TOKENS_PER_SECOND', 4),
      burst: parseIntEnv('TEAMTAILOR_RATE_BURST', 10),
    },
  });

  try {
    const result = await runIncremental(syncer, { db, client });
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
