/**
 * E2E test for runIncremental + candidatesSyncer.
 *
 * Covers: basic upsert, tolerance for mostly-null PII (Teamtailor
 * allows ghost candidates with all fields null), idempotency.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { candidatesSyncer } from '../../../src/lib/sync/candidates';
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
const candidatesPage1 = JSON.parse(
  readFileSync(path.join(fixturesDir, 'candidates-mvp-page-1.json'), 'utf-8'),
);

const IDS = ['9001', '9002', '9003'];

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

describe('runIncremental + candidatesSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    await db.from('candidates').delete().in('teamtailor_id', IDS);
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
      .eq('entity', 'candidates');
    await db.from('sync_errors').delete().eq('entity', 'candidates');
  });

  it('upserts candidates (including ghost all-null ones)', async () => {
    server.use(http.get(`${BASE_URL}/candidates`, () => HttpResponse.json(candidatesPage1)));
    const result = await runIncremental(candidatesSyncer, { db, client: makeTeamtailorClient() });
    expect(result.recordsSynced).toBe(3);
    expect(result.rowErrors).toBe(0);

    const { data: rows } = await db
      .from('candidates')
      .select('teamtailor_id, first_name, last_name, email, phone, linkedin_url, pitch, sourced')
      .in('teamtailor_id', IDS)
      .order('teamtailor_id');
    expect(rows).toHaveLength(3);
    expect(rows![0]).toMatchObject({
      teamtailor_id: '9001',
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.test',
      phone: '+44 20 7946 0001',
      linkedin_url: 'https://www.linkedin.com/in/ada-test',
      pitch: 'Analytical Engine enthusiast.',
      sourced: true,
    });
    expect(rows![1]).toMatchObject({
      teamtailor_id: '9002',
      first_name: 'Alan',
      email: 'alan@example.test',
      phone: null,
      linkedin_url: null,
      sourced: false,
    });
    // Ghost candidate: all PII fields null, row still persisted.
    expect(rows![2]).toMatchObject({
      teamtailor_id: '9003',
      first_name: null,
      last_name: null,
      email: null,
      sourced: false,
    });

    const state = await readSyncState(db, 'candidates');
    expect(state.lastRunStatus).toBe('success');
    expect(state.recordsSynced).toBe(3);
  });

  it('is idempotent: running twice keeps the same 3 rows', async () => {
    server.use(http.get(`${BASE_URL}/candidates`, () => HttpResponse.json(candidatesPage1)));
    await runIncremental(candidatesSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(candidatesSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('candidates')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', IDS);
    expect(count).toBe(3);
  });
});
