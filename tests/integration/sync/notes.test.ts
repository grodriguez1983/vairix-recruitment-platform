/**
 * E2E test for runIncremental + notesSyncer.
 *
 * Notes carry FK reconciliation similar to applications:
 *   - `candidate` relationship → resolve to candidates.id (REQUIRED).
 *   - `job-application` relationship → resolve to applications.id (optional).
 *   - `user` relationship → resolve to users.id (optional).
 *
 * Covers:
 *   - Happy path with all FKs resolved.
 *   - Note with only candidate (no application, no user).
 *   - Empty body → row-level error (body NOT NULL in schema).
 *   - Orphan candidate → row lands in sync_errors.
 *   - Idempotency.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { notesSyncer } from '../../../src/lib/sync/notes';
import { TeamtailorClient } from '../../../src/lib/teamtailor/client';

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
const notesPage1 = JSON.parse(readFileSync(path.join(fixturesDir, 'notes-page-1.json'), 'utf-8'));

const NOTE_IDS = ['20001', '20002', '20003', '20004'];
const CANDIDATE_TT_ID = '9001';
const APPLICATION_TT_ID = '10001';
const USER_TT_ID = '5001';

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

describe('runIncremental + notesSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    // Clean slate — order matters (FK cascades): notes → applications → candidates/users.
    await db.from('notes').delete().in('teamtailor_id', NOTE_IDS);
    await db.from('applications').delete().eq('teamtailor_id', APPLICATION_TT_ID);
    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);
    await db.from('users').delete().eq('teamtailor_id', USER_TT_ID);

    // Seed referenced parents.
    const { data: cand } = await db
      .from('candidates')
      .insert({
        teamtailor_id: CANDIDATE_TT_ID,
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: 'ada@example.test',
        raw_data: {},
      })
      .select('id')
      .single();

    await db.from('applications').insert({
      teamtailor_id: APPLICATION_TT_ID,
      candidate_id: cand!.id,
      raw_data: {},
    });

    await db.from('users').insert({
      teamtailor_id: USER_TT_ID,
      name: 'Grace Hopper',
      email: 'grace@example.test',
      raw_data: {},
    });

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
      .eq('entity', 'notes');
    await db.from('sync_errors').delete().eq('entity', 'notes');
  });

  it('upserts notes with FK reconciliation; orphans + empty body go to sync_errors', async () => {
    server.use(http.get(`${BASE_URL}/notes`, () => HttpResponse.json(notesPage1)));
    const result = await runIncremental(notesSyncer, {
      db,
      client: makeTeamtailorClient(),
    });
    // 20001 + 20002 inserted. 20003 (empty body) + 20004 (orphan candidate) skipped.
    expect(result.recordsSynced).toBe(2);

    const { data: candidateRow } = await db
      .from('candidates')
      .select('id')
      .eq('teamtailor_id', CANDIDATE_TT_ID)
      .single();
    const { data: appRow } = await db
      .from('applications')
      .select('id')
      .eq('teamtailor_id', APPLICATION_TT_ID)
      .single();
    const { data: userRow } = await db
      .from('users')
      .select('id')
      .eq('teamtailor_id', USER_TT_ID)
      .single();

    const { data: notes } = await db
      .from('notes')
      .select('teamtailor_id, candidate_id, application_id, user_id, body')
      .in('teamtailor_id', NOTE_IDS)
      .order('teamtailor_id');

    expect(notes).toHaveLength(2);
    expect(notes![0]).toMatchObject({
      teamtailor_id: '20001',
      candidate_id: candidateRow!.id,
      application_id: appRow!.id,
      user_id: userRow!.id,
    });
    expect(notes![0]!.body).toContain('Postgres');
    expect(notes![1]).toMatchObject({
      teamtailor_id: '20002',
      candidate_id: candidateRow!.id,
      application_id: null,
      user_id: null,
    });

    const { data: errs } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_code')
      .eq('entity', 'notes')
      .order('teamtailor_id');
    expect(errs).toHaveLength(2);
    const ids = errs!.map((e) => e.teamtailor_id);
    expect(ids).toContain('20003');
    expect(ids).toContain('20004');
  });

  it('is idempotent: running twice keeps the same 2 rows', async () => {
    server.use(http.get(`${BASE_URL}/notes`, () => HttpResponse.json(notesPage1)));
    await runIncremental(notesSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(notesSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('notes')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', NOTE_IDS);
    expect(count).toBe(2);
  });
});
