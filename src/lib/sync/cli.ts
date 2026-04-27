/**
 * Shared runtime for sync CLI scripts (sync-incremental, sync-full,
 * backfill). Extracted per ADR-028 §"Helper compartido" so the three
 * entrypoints don't drift on env loading, syncer construction, or
 * scope-set semantics.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { TeamtailorClient } from '../teamtailor/client';
import { BUCKET as CV_BUCKET } from '../cv/downloader';
import { applicationsSyncer } from './applications';
import { downloadResumesForCandidates } from './candidate-resumes';
import { makeCandidatesSyncer } from './candidates';
import { customFieldsSyncer } from './custom-fields';
import { interviewsSyncer } from './interviews';
import { jobsSyncer } from './jobs';
import { notesSyncer } from './notes';
import type { EntitySyncer } from './run';
import { stagesSyncer } from './stages';
import { makeUploadsSyncer } from './uploads';
import { usersSyncer } from './users';

export function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[sync] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

export function parseIntEnv(name: string, fallback: number): number {
  const v = process.env[name];
  if (!v) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) {
    console.error(`[sync] invalid ${name}="${v}" (expected positive number)`);
    process.exit(2);
  }
  return n;
}

export function parseOptionalPositiveInt(name: string): number | undefined {
  const v = process.env[name];
  if (!v) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || !Number.isInteger(n)) {
    console.error(`[sync] invalid ${name}="${v}" (expected positive integer)`);
    process.exit(2);
  }
  return n;
}

export function parseBoolEnv(name: string): boolean {
  const v = process.env[name];
  if (!v) return false;
  return v === '1' || v.toLowerCase() === 'true';
}

/**
 * Reads every `candidates.teamtailor_id` currently in local DB into a
 * Set. Callers pass the result via `SyncerDeps.scopeCandidateTtIds`
 * so child syncers silently drop rows whose candidate is out of
 * scope. The page size is intentionally conservative (≤ Supabase
 * default `max_rows=1000`) to avoid PostgREST EOF ambiguity.
 */
export async function loadScopeCandidateTtIds(db: SupabaseClient): Promise<Set<string>> {
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

/**
 * Resets the cursor watermark for a `sync_state` row so the next
 * `runIncremental` call starts from the first page of Teamtailor
 * (no `filter[updated-at][from]`). Used by the backfill script
 * (ADR-028 §"sync:backfill") to force a full re-fetch of an entity.
 */
export async function resetCursor(db: SupabaseClient, entity: string): Promise<void> {
  const { error } = await db
    .from('sync_state')
    .update({ last_cursor: null, last_synced_at: null })
    .eq('entity', entity);
  if (error) {
    console.error(`[sync] failed to reset cursor for "${entity}": ${error.message}`);
    process.exit(4);
  }
}

/**
 * Builds the entity → syncer registry. The registry is the single
 * source of truth for which entities the CLI knows how to sync;
 * `CANONICAL_ENTITY_ORDER` (in `orchestration.ts`) MUST stay in
 * paritary with `Object.keys(buildSyncers(db))` — the test
 * `cli.test.ts:test_build_syncers_keys_match_canonical_order` pins
 * the invariant.
 *
 * Candidates and uploads syncers both need a live Storage bucket
 * client (ADR-006, ADR-018), so they're constructed inside this
 * factory once `db` exists.
 */
export function buildSyncers(db: SupabaseClient): Record<string, EntitySyncer<unknown>> {
  const storage = db.storage.from(CV_BUCKET);
  const candidatesSyncerWithResumes = makeCandidatesSyncer({
    // ADR-018: post-upsert hook downloads candidates.attributes.resume
    // into `files` with source='candidate_resume'. The URL is only
    // valid ~60s so the download MUST happen in the candidates pass.
    downloadResumesForRows: (inputs, candidateIdByTtId) =>
      downloadResumesForCandidates(inputs, candidateIdByTtId, db, {
        fetch: globalThis.fetch.bind(globalThis),
        storage,
        randomUuid: () => globalThis.crypto.randomUUID(),
      }),
  });
  return {
    stages: stagesSyncer as EntitySyncer<unknown>,
    users: usersSyncer as EntitySyncer<unknown>,
    jobs: jobsSyncer as EntitySyncer<unknown>,
    'custom-fields': customFieldsSyncer as EntitySyncer<unknown>,
    candidates: candidatesSyncerWithResumes as EntitySyncer<unknown>,
    applications: applicationsSyncer as EntitySyncer<unknown>,
    notes: notesSyncer as EntitySyncer<unknown>,
    // `/v1/interviews` → evaluations + evaluation_answers.
    evaluations: interviewsSyncer as EntitySyncer<unknown>,
    // `/v1/uploads` → files (binary → candidate-cvs bucket).
    files: makeUploadsSyncer({ storage }) as EntitySyncer<unknown>,
  };
}

export interface BuildClientArgs {
  apiKey: string;
  apiVersion: string;
  baseUrl: string;
  tokensPerSecond: number;
  burst: number;
}

export function buildTeamtailorClient(args: BuildClientArgs): TeamtailorClient {
  return new TeamtailorClient({
    apiKey: args.apiKey,
    apiVersion: args.apiVersion,
    baseUrl: args.baseUrl,
    rateLimit: { tokensPerSecond: args.tokensPerSecond, burst: args.burst },
  });
}
