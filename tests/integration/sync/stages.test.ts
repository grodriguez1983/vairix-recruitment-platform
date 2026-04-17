/**
 * End-to-end-ish tests for runIncremental + stagesSyncer.
 *
 * MSW intercepts Teamtailor requests; Supabase local receives the
 * upserts. The runner+syncer integrate lock, paginate, retry,
 * mapping, upsert, and sync_errors.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { stagesSyncer } from '../../../src/lib/sync/stages';
import { TeamtailorClient } from '../../../src/lib/teamtailor/client';
import { readSyncState } from '../../../src/lib/sync/lock';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const BASE_URL = 'https://tt.test/v1';

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  '..',
  'fixtures',
  'teamtailor',
);
const stagesPage1 = JSON.parse(readFileSync(path.join(fixturesDir, 'stages-page-1.json'), 'utf-8'));
const stagesPage2 = JSON.parse(readFileSync(path.join(fixturesDir, 'stages-page-2.json'), 'utf-8'));
const stagesPage1WithBad = JSON.parse(
  readFileSync(path.join(fixturesDir, 'stages-page-1-with-bad-row.json'), 'utf-8'),
);

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function makeTeamtailorClient(): TeamtailorClient {
  return new TeamtailorClient({
    apiKey: 'test-key',
    apiVersion: '20240904',
    baseUrl: BASE_URL,
    rateLimit: { tokensPerSecond: 100, burst: 100 },
    retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, jitter: (ms: number) => ms },
    sleep: async () => {},
  });
}

const server = setupServer();
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }));
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('runIncremental + stagesSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    // Clean stages + reset sync_state row for 'stages' to idle.
    await db.from('stages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await db
      .from('sync_state')
      .update({
        last_run_status: 'idle',
        last_run_started: null,
        last_run_finished: null,
        last_run_error: null,
        last_synced_at: null,
        last_cursor: null,
        records_synced: 0,
      })
      .eq('entity', 'stages');
    // Clean any sync_errors from prior runs.
    await db.from('sync_errors').delete().eq('entity', 'stages');
  });

  it('upserts all pages; sync_state transitions to success with correct count', async () => {
    server.use(
      http.get(`${BASE_URL}/stages`, ({ request }) => {
        const u = new URL(request.url);
        const num = u.searchParams.get('page[number]') ?? '1';
        return num === '2' ? HttpResponse.json(stagesPage2) : HttpResponse.json(stagesPage1);
      }),
    );

    const result = await runIncremental(stagesSyncer, {
      db,
      client: makeTeamtailorClient(),
    });

    expect(result.recordsSynced).toBe(3);
    expect(result.rowErrors).toBe(0);

    const { data: rows, error } = await db
      .from('stages')
      .select('teamtailor_id, name, position')
      .in('teamtailor_id', ['9001', '9002', '9003'])
      .order('position');
    expect(error).toBeNull();
    expect(rows).toHaveLength(3);
    expect(rows![0]!.teamtailor_id).toBe('9001');

    const state = await readSyncState(db, 'stages');
    expect(state.lastRunStatus).toBe('success');
    expect(state.recordsSynced).toBe(3);
    expect(state.lastSyncedAt).not.toBeNull();
  });

  it('is idempotent: running twice produces the same 3 rows', async () => {
    server.use(
      http.get(`${BASE_URL}/stages`, ({ request }) => {
        const u = new URL(request.url);
        const num = u.searchParams.get('page[number]') ?? '1';
        return num === '2' ? HttpResponse.json(stagesPage2) : HttpResponse.json(stagesPage1);
      }),
    );

    await runIncremental(stagesSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(stagesSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('stages')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', ['9001', '9002', '9003']);
    expect(count).toBe(3);
  });

  it('row error does NOT stop batch: bad row logged to sync_errors, others persisted', async () => {
    server.use(http.get(`${BASE_URL}/stages`, () => HttpResponse.json(stagesPage1WithBad)));

    const result = await runIncremental(stagesSyncer, {
      db,
      client: makeTeamtailorClient(),
    });

    expect(result.recordsSynced).toBe(2);
    expect(result.rowErrors).toBe(1);

    const { data: rows } = await db
      .from('stages')
      .select('teamtailor_id')
      .in('teamtailor_id', ['9001', '9002', '9003']);
    // The bad row (9002) must NOT be present.
    const ids = (rows ?? []).map((r) => r.teamtailor_id).sort();
    expect(ids).toEqual(['9001', '9003']);

    const { data: errors } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_message')
      .eq('entity', 'stages');
    expect(errors).toHaveLength(1);
    expect(errors![0]!.teamtailor_id).toBe('9002');

    const state = await readSyncState(db, 'stages');
    expect(state.lastRunStatus).toBe('success');
  });

  it('fatal TT error: last_synced_at stays pinned to prior watermark', async () => {
    // Pre-seed a prior successful watermark.
    const prior = '2026-03-01T00:00:00.000Z';
    await db
      .from('sync_state')
      .update({ last_synced_at: prior, records_synced: 5 })
      .eq('entity', 'stages');

    server.use(http.get(`${BASE_URL}/stages`, () => new HttpResponse(null, { status: 500 })));

    await expect(
      runIncremental(stagesSyncer, { db, client: makeTeamtailorClient() }),
    ).rejects.toThrow();

    const state = await readSyncState(db, 'stages');
    expect(state.lastRunStatus).toBe('error');
    expect(new Date(state.lastSyncedAt!).getTime()).toBe(new Date(prior).getTime());
  });
});
