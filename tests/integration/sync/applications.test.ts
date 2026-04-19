/**
 * E2E test for runIncremental + applicationsSyncer.
 *
 * Applications are the first syncer that performs FK reconciliation:
 * it must resolve `candidate_tt_id`, `job_tt_id`, `stage_tt_id`
 * (from JSON:API relationships) into local UUIDs.
 *
 * Covers:
 *   - Happy path with all FKs resolved.
 *   - Nullable stage (application without a current stage).
 *   - Orphan candidate → row lands in sync_errors, NOT in applications,
 *     and the run still completes.
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
import { applicationsSyncer } from '../../../src/lib/sync/applications';
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
const applicationsPage1 = JSON.parse(
  readFileSync(path.join(fixturesDir, 'applications-page-1.json'), 'utf-8'),
);

const APP_IDS = ['10001', '10002', '10003'];
const CANDIDATE_TT_ID = '9001';
const JOB_TT_ID = '7001';
const STAGE_TT_ID = '3001';

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

describe('runIncremental + applicationsSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    // Clean slate — order matters: applications → candidates/jobs/stages.
    await db.from('applications').delete().in('teamtailor_id', APP_IDS);
    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);
    await db.from('jobs').delete().eq('teamtailor_id', JOB_TT_ID);
    await db.from('stages').delete().eq('teamtailor_id', STAGE_TT_ID);

    // Seed referenced parents so FK reconciliation can succeed.
    await db.from('candidates').insert({
      teamtailor_id: CANDIDATE_TT_ID,
      first_name: 'Ada',
      last_name: 'Lovelace',
      email: 'ada@example.test',
      raw_data: {},
    });
    await db.from('jobs').insert({
      teamtailor_id: JOB_TT_ID,
      title: 'Senior Backend Engineer',
      status: 'open',
      raw_data: {},
    });
    await db.from('stages').insert({
      teamtailor_id: STAGE_TT_ID,
      name: 'Interview',
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
      .eq('entity', 'applications');
    await db.from('sync_errors').delete().eq('entity', 'applications');
  });

  it('upserts applications with FK reconciliation; orphan goes to sync_errors', async () => {
    server.use(
      http.get(`${BASE_URL}/job-applications`, () => HttpResponse.json(applicationsPage1)),
    );
    const result = await runIncremental(applicationsSyncer, {
      db,
      client: makeTeamtailorClient(),
    });
    // 2 inserted (10001, 10002); 10003 skipped (orphan candidate).
    expect(result.recordsSynced).toBe(2);

    // Look up resolved UUIDs.
    const { data: candidateRow } = await db
      .from('candidates')
      .select('id')
      .eq('teamtailor_id', CANDIDATE_TT_ID)
      .single();
    const { data: jobRow } = await db
      .from('jobs')
      .select('id')
      .eq('teamtailor_id', JOB_TT_ID)
      .single();
    const { data: stageRow } = await db
      .from('stages')
      .select('id')
      .eq('teamtailor_id', STAGE_TT_ID)
      .single();

    const { data: apps } = await db
      .from('applications')
      .select('teamtailor_id, candidate_id, job_id, stage_id, status, source, rejected_at')
      .in('teamtailor_id', APP_IDS)
      .order('teamtailor_id');
    expect(apps).toHaveLength(2);
    expect(apps![0]).toMatchObject({
      teamtailor_id: '10001',
      candidate_id: candidateRow!.id,
      job_id: jobRow!.id,
      stage_id: stageRow!.id,
      status: 'active',
      source: 'linkedin',
      rejected_at: null,
    });
    expect(apps![1]).toMatchObject({
      teamtailor_id: '10002',
      candidate_id: candidateRow!.id,
      job_id: jobRow!.id,
      stage_id: null,
      status: 'rejected',
      source: 'careers-site',
    });
    expect(apps![1]!.rejected_at).not.toBeNull();

    // Orphan application recorded in sync_errors.
    const { data: errs } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_code')
      .eq('entity', 'applications');
    expect(errs).toHaveLength(1);
    expect(errs![0]!.teamtailor_id).toBe('10003');
  });

  it('scopeCandidateTtIds silently drops out-of-scope orphans (no sync_errors row)', async () => {
    // Same fixture as the orphan test: 10001 + 10002 reference candidate
    // 9001 (seeded), 10003 references 99999 (unseeded). Without scope,
    // 10003 → sync_errors. With scope = {9001}, 10003 is silently
    // dropped: zero sync_errors rows for this entity.
    server.use(
      http.get(`${BASE_URL}/job-applications`, () => HttpResponse.json(applicationsPage1)),
    );
    const result = await runIncremental(applicationsSyncer, {
      db,
      client: makeTeamtailorClient(),
      scopeCandidateTtIds: new Set([CANDIDATE_TT_ID]),
    });
    expect(result.recordsSynced).toBe(2);

    const { data: apps } = await db
      .from('applications')
      .select('teamtailor_id')
      .in('teamtailor_id', APP_IDS)
      .order('teamtailor_id');
    expect(apps?.map((r) => r.teamtailor_id)).toEqual(['10001', '10002']);

    const { data: errs } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_code')
      .eq('entity', 'applications');
    expect(errs).toHaveLength(0);
  });

  it('is idempotent: running twice keeps the same 2 rows', async () => {
    server.use(
      http.get(`${BASE_URL}/job-applications`, () => HttpResponse.json(applicationsPage1)),
    );
    await runIncremental(applicationsSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(applicationsSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('applications')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', APP_IDS);
    expect(count).toBe(2);
  });
});
