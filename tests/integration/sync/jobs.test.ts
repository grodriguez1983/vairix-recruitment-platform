/**
 * E2E test for runIncremental + jobsSyncer.
 *
 * Covers: basic upsert of all statuses, idempotency, and tolerance
 * for unknown `status` values (TT may ship new statuses before our
 * schema's CHECK constraint knows about them — we store null rather
 * than fail the row).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { jobsSyncer } from '../../../src/lib/sync/jobs';
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
const jobsPage1 = JSON.parse(readFileSync(path.join(fixturesDir, 'jobs-page-1.json'), 'utf-8'));

const IDS = ['7001', '7002', '7003', '7004'];

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
beforeAll(() =>
  server.listen({
    onUnhandledRequest: (req, print) => {
      if (req.url.startsWith(BASE_URL)) print.error();
    },
  }),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('runIncremental + jobsSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    await db.from('jobs').delete().in('teamtailor_id', IDS);
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
      .eq('entity', 'jobs');
    await db.from('sync_errors').delete().eq('entity', 'jobs');
  });

  it('upserts jobs across all statuses (tolerant to unknown status)', async () => {
    server.use(http.get(`${BASE_URL}/jobs`, () => HttpResponse.json(jobsPage1)));
    const result = await runIncremental(jobsSyncer, { db, client: makeTeamtailorClient() });
    expect(result.recordsSynced).toBe(4);
    expect(result.rowErrors).toBe(0);

    const { data: rows } = await db
      .from('jobs')
      .select('teamtailor_id, title, status, pitch')
      .in('teamtailor_id', IDS)
      .order('teamtailor_id');
    expect(rows).toHaveLength(4);
    expect(rows![0]).toMatchObject({
      teamtailor_id: '7001',
      title: 'Senior Backend Engineer',
      status: 'open',
      pitch: 'Build the payments core.',
    });
    expect(rows![1]).toMatchObject({ teamtailor_id: '7002', status: 'draft' });
    expect(rows![2]).toMatchObject({ teamtailor_id: '7003', status: 'archived' });
    // Unknown status must map to null (tolerant); row still inserted.
    expect(rows![3]).toMatchObject({
      teamtailor_id: '7004',
      title: 'Unknown Status Job',
      status: null,
    });

    const state = await readSyncState(db, 'jobs');
    expect(state.lastRunStatus).toBe('success');
    expect(state.recordsSynced).toBe(4);
  });

  it('is idempotent: running twice keeps the same 4 rows', async () => {
    server.use(http.get(`${BASE_URL}/jobs`, () => HttpResponse.json(jobsPage1)));
    await runIncremental(jobsSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(jobsSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('jobs')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', IDS);
    expect(count).toBe(4);
  });
});
