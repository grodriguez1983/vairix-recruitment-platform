/**
 * End-to-end test for the candidates syncer extended with
 * `custom-field-values` sideload (ADR-010 §2).
 *
 * Seeds the `custom_fields` catalog directly so the test is
 * decoupled from the custom-fields syncer. Intercepts
 * `/candidates?include=...` with a fixture whose `included` array
 * carries the three custom-field-values, and verifies:
 *   - candidates rows upserted as before
 *   - candidate_custom_field_values rows produced with the right
 *     typed column populated per field_type
 *   - `raw_value` always preserved for auditability
 *   - idempotency across two runs
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
const fixture = JSON.parse(
  readFileSync(path.join(fixturesDir, 'candidates-with-custom-values-page-1.json'), 'utf-8'),
);

const CANDIDATE_IDS = ['7001', '7002'];
const CATALOG_IDS = ['465', '1458'];
const VALUE_IDS = ['v-1', 'v-2', 'v-3'];

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

describe('candidatesSyncer with custom-field-values sideload', () => {
  const db = svc();

  beforeEach(async () => {
    // Clean rows produced by prior runs.
    await db.from('candidate_custom_field_values').delete().in('teamtailor_value_id', VALUE_IDS);
    await db.from('candidates').delete().in('teamtailor_id', CANDIDATE_IDS);
    await db.from('custom_fields').delete().in('teamtailor_id', CATALOG_IDS);
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

    // Seed the catalog the sideload references.
    await db.from('custom_fields').upsert(
      [
        {
          teamtailor_id: '465',
          api_name: 'asp-salariales',
          name: 'Asp salariales',
          field_type: 'CustomField::Text',
          owner_type: 'Candidate',
          is_private: true,
          is_searchable: true,
          raw_data: null,
        },
        {
          teamtailor_id: '1458',
          api_name: 'ltimo-seguimiento',
          name: 'Último seguimiento',
          field_type: 'CustomField::Date',
          owner_type: 'Candidate',
          is_private: false,
          is_searchable: true,
          raw_data: null,
        },
      ],
      { onConflict: 'teamtailor_id' },
    );
  });

  it('upserts candidates and their custom-field-values with typed columns', async () => {
    server.use(http.get(`${BASE_URL}/candidates`, () => HttpResponse.json(fixture)));

    const result = await runIncremental(candidatesSyncer, {
      db,
      client: makeTeamtailorClient(),
    });

    expect(result.recordsSynced).toBe(2);
    expect(result.rowErrors).toBe(0);

    // Candidates landed as usual.
    const { data: candidates } = await db
      .from('candidates')
      .select('id, teamtailor_id, first_name')
      .in('teamtailor_id', CANDIDATE_IDS);
    expect(candidates).toHaveLength(2);

    // Values landed with the correct typed column per field_type.
    const { data: values } = await db
      .from('candidate_custom_field_values')
      .select(
        'teamtailor_value_id, field_type, value_text, value_date, value_number, value_boolean, raw_value, candidate_id, custom_field_id',
      )
      .in('teamtailor_value_id', VALUE_IDS);
    expect(values).toHaveLength(3);

    const byValueId = Object.fromEntries((values ?? []).map((v) => [v.teamtailor_value_id, v]));

    // v-1 → Text, value_text populated, raw_value always preserved.
    expect(byValueId['v-1']!.field_type).toBe('CustomField::Text');
    expect(byValueId['v-1']!.value_text).toBe('75000');
    expect(byValueId['v-1']!.value_date).toBeNull();
    expect(byValueId['v-1']!.raw_value).toBe('75000');

    // v-2 → Date, value_date populated (ISO 8601 string).
    expect(byValueId['v-2']!.field_type).toBe('CustomField::Date');
    expect(byValueId['v-2']!.value_date).toBe('2026-01-15');
    expect(byValueId['v-2']!.value_text).toBeNull();
    expect(byValueId['v-2']!.raw_value).toBe('2026-01-15');

    // v-3 → Date on the other candidate.
    expect(byValueId['v-3']!.field_type).toBe('CustomField::Date');
    expect(byValueId['v-3']!.value_date).toBe('2026-02-20');
  });

  it('is idempotent: running twice keeps the same 3 value rows', async () => {
    server.use(http.get(`${BASE_URL}/candidates`, () => HttpResponse.json(fixture)));

    await runIncremental(candidatesSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(candidatesSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('candidate_custom_field_values')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_value_id', VALUE_IDS);
    expect(count).toBe(3);
  });
});
