/**
 * E2E test for runIncremental + interviewsSyncer.
 *
 * `/v1/interviews` carries:
 *   - `note` (the free-text evaluation — lands in evaluations.notes).
 *   - `status` (published / draft).
 *   - relationships: candidate (REQUIRED), job (optional, resolves
 *     to applications.id via (candidate, job)), user (optional), and
 *     `answers` (sideloaded). Each answer is bound to a question and
 *     expresses one of text/range/boolean/number/date per
 *     question-type. Answers land in evaluation_answers with the
 *     typed column populated.
 *
 * Covers:
 *   - Happy path: interview + answers with mixed types (text, range,
 *     boolean), incl. the VAIRIX "Información para CV" URL (q=24016).
 *   - Draft interview with no answers still upserts the evaluation.
 *   - Orphan candidate → evaluation lands in sync_errors, answers
 *     don't orphan-cascade to evaluation_answers.
 *   - Idempotency across two runs.
 *   - application_id resolved via (candidate_id, job_id) lookup; null
 *     when no matching application.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { interviewsSyncer } from '../../../src/lib/sync/interviews';
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
const interviewsPage1 = JSON.parse(
  readFileSync(path.join(fixturesDir, 'interviews-page-1.json'), 'utf-8'),
);

const INTERVIEW_IDS = ['30001', '30002', '30003'];
const CANDIDATE_TT_ID = '9001';
const JOB_TT_ID = '8001';
const USER_TT_ID = '5001';
const APPLICATION_TT_ID = '10001';

const VAIRIX_CV_URL =
  'https://docs.google.com/spreadsheets/d/1JNQaO8ojJl9On7v8lrzb2xYRlxHYBt1AnUZY-mNvL2k/edit?gid=0#gid=0';

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

describe('runIncremental + interviewsSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    // Clean slate. evaluation_answers has FK on evaluations; cascade deletes
    // handle it, but we also scope by teamtailor_id to leave the rest alone.
    await db.from('evaluations').delete().in('teamtailor_id', INTERVIEW_IDS);
    await db.from('applications').delete().eq('teamtailor_id', APPLICATION_TT_ID);
    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);
    await db.from('users').delete().eq('teamtailor_id', USER_TT_ID);
    await db.from('jobs').delete().eq('teamtailor_id', JOB_TT_ID);

    // Seed parents that relationships resolve to.
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

    const { data: job } = await db
      .from('jobs')
      .insert({
        teamtailor_id: JOB_TT_ID,
        title: 'Senior RoR',
        raw_data: {},
      })
      .select('id')
      .single();

    await db.from('applications').insert({
      teamtailor_id: APPLICATION_TT_ID,
      candidate_id: cand!.id,
      job_id: job!.id,
      raw_data: {},
    });

    await db.from('users').insert({
      teamtailor_id: USER_TT_ID,
      full_name: 'Grace Hopper',
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
      .eq('entity', 'evaluations');
    await db.from('sync_errors').delete().eq('entity', 'evaluations');
  });

  it('upserts evaluations + typed answers; orphan interview goes to sync_errors', async () => {
    server.use(http.get(`${BASE_URL}/interviews`, () => HttpResponse.json(interviewsPage1)));
    const result = await runIncremental(interviewsSyncer, {
      db,
      client: makeTeamtailorClient(),
    });

    // iv 30001 + 30002 inserted. 30003 (orphan candidate) → sync_errors.
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

    const { data: evals } = await db
      .from('evaluations')
      .select('id, teamtailor_id, candidate_id, application_id, user_id, notes')
      .in('teamtailor_id', INTERVIEW_IDS)
      .order('teamtailor_id');

    expect(evals).toHaveLength(2);
    expect(evals![0]).toMatchObject({
      teamtailor_id: '30001',
      candidate_id: candidateRow!.id,
      application_id: appRow!.id,
      user_id: userRow!.id,
    });
    expect(evals![0]!.notes).toContain('Perfil senior');
    expect(evals![1]).toMatchObject({
      teamtailor_id: '30002',
      candidate_id: candidateRow!.id,
      application_id: null,
      user_id: userRow!.id,
    });

    // Answers of iv-30001 landed with typed columns populated per
    // question-type.
    const eval30001 = evals!.find((e) => e.teamtailor_id === '30001')!;
    const { data: answers } = await db
      .from('evaluation_answers')
      .select(
        'teamtailor_answer_id, question_tt_id, question_title, question_type, value_text, value_range, value_boolean',
      )
      .eq('evaluation_id', eval30001.id)
      .order('teamtailor_answer_id');
    expect(answers).toHaveLength(4);

    const byAnsId = Object.fromEntries((answers ?? []).map((a) => [a.teamtailor_answer_id, a]));

    // 1205701 — text question (Nivel técnico)
    expect(byAnsId['1205701']!.question_tt_id).toBe('24010');
    expect(byAnsId['1205701']!.question_type).toBe('text');
    expect(byAnsId['1205701']!.value_text).toContain('Rails senior');
    expect(byAnsId['1205701']!.value_range).toBeNull();
    expect(byAnsId['1205701']!.question_title).toBe('Nivel técnico principales tecnologías');

    // 1205702 — range 4
    expect(byAnsId['1205702']!.question_type).toBe('range');
    expect(Number(byAnsId['1205702']!.value_range)).toBe(4);
    expect(byAnsId['1205702']!.value_text).toBeNull();

    // 1205703 — VAIRIX Información para CV URL
    expect(byAnsId['1205703']!.question_tt_id).toBe('24016');
    expect(byAnsId['1205703']!.question_title).toBe('Información para CV');
    expect(byAnsId['1205703']!.value_text).toBe(VAIRIX_CV_URL);

    // 1205704 — boolean true (Conclusión avance)
    expect(byAnsId['1205704']!.question_type).toBe('boolean');
    expect(byAnsId['1205704']!.value_boolean).toBe(true);

    // iv-30002 has no answers.
    const eval30002 = evals!.find((e) => e.teamtailor_id === '30002')!;
    const { count: emptyCount } = await db
      .from('evaluation_answers')
      .select('*', { count: 'exact', head: true })
      .eq('evaluation_id', eval30002.id);
    expect(emptyCount).toBe(0);

    // Orphan candidate made it to sync_errors.
    const { data: errs } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_code')
      .eq('entity', 'evaluations');
    expect(errs).toHaveLength(1);
    expect(errs![0]!.teamtailor_id).toBe('30003');
  });

  it('is idempotent: running twice keeps 2 evaluations and 4 answers', async () => {
    server.use(http.get(`${BASE_URL}/interviews`, () => HttpResponse.json(interviewsPage1)));
    await runIncremental(interviewsSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(interviewsSyncer, { db, client: makeTeamtailorClient() });

    const { count: evalCount } = await db
      .from('evaluations')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', INTERVIEW_IDS);
    expect(evalCount).toBe(2);

    const { data: evalIds } = await db
      .from('evaluations')
      .select('id')
      .in('teamtailor_id', INTERVIEW_IDS);
    const ids = (evalIds ?? []).map((e) => e.id);

    const { count: ansCount } = await db
      .from('evaluation_answers')
      .select('*', { count: 'exact', head: true })
      .in('evaluation_id', ids);
    expect(ansCount).toBe(4);
  });
});
