/**
 * E2E test for runIncremental + usersSyncer.
 *
 * Covers: basic upsert, idempotency, tolerant mapping for evaluators
 * without email (TT allows "deleted" / invisible users to have
 * null email and role).
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { usersSyncer } from '../../../src/lib/sync/users';
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
const usersPage1 = JSON.parse(readFileSync(path.join(fixturesDir, 'users-page-1.json'), 'utf-8'));

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

describe('runIncremental + usersSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    await db.from('users').delete().in('teamtailor_id', ['5001', '5002', '5003']);
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
      .eq('entity', 'users');
    await db.from('sync_errors').delete().eq('entity', 'users');
  });

  it('upserts evaluators (including invisible/null-email ones)', async () => {
    server.use(http.get(`${BASE_URL}/users`, () => HttpResponse.json(usersPage1)));
    const result = await runIncremental(usersSyncer, { db, client: makeTeamtailorClient() });
    expect(result.recordsSynced).toBe(3);
    expect(result.rowErrors).toBe(0);

    const { data: rows } = await db
      .from('users')
      .select('teamtailor_id, email, full_name, role, active')
      .in('teamtailor_id', ['5001', '5002', '5003'])
      .order('teamtailor_id');
    expect(rows).toHaveLength(3);
    expect(rows![0]).toMatchObject({
      teamtailor_id: '5001',
      email: 'maria@example.test',
      full_name: 'María García',
      role: 'hiring_manager',
      active: true,
    });
    // Invisible deleted user preserves null fields and active=false.
    expect(rows![2]).toMatchObject({
      teamtailor_id: '5003',
      email: null,
      role: null,
      active: false,
    });

    const state = await readSyncState(db, 'users');
    expect(state.lastRunStatus).toBe('success');
    expect(state.recordsSynced).toBe(3);
  });

  it('is idempotent: running twice keeps the same 3 rows', async () => {
    server.use(http.get(`${BASE_URL}/users`, () => HttpResponse.json(usersPage1)));
    await runIncremental(usersSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(usersSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('users')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', ['5001', '5002', '5003']);
    expect(count).toBe(3);
  });
});
