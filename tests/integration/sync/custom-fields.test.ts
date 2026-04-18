/**
 * End-to-end tests for runIncremental + customFieldsSyncer.
 *
 * Mirrors the shape of stages.test.ts. MSW intercepts Teamtailor;
 * Supabase local receives the upserts. The catalog is low-volume, so
 * we test a single page plus idempotency.
 *
 * Ref: ADR-010 §5.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { customFieldsSyncer } from '../../../src/lib/sync/custom-fields';
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
const customFieldsPage1 = JSON.parse(
  readFileSync(path.join(fixturesDir, 'custom-fields-page-1.json'), 'utf-8'),
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
beforeAll(() =>
  server.listen({
    onUnhandledRequest: (req, print) => {
      if (req.url.startsWith(BASE_URL)) print.error();
    },
  }),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('runIncremental + customFieldsSyncer', () => {
  const db = svc();

  beforeEach(async () => {
    await db
      .from('custom_fields')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
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
      .eq('entity', 'custom-fields');
    await db.from('sync_errors').delete().eq('entity', 'custom-fields');
  });

  it('upserts custom fields preserving api_name, field_type, is_private', async () => {
    server.use(
      http.get(`${BASE_URL}/custom-fields`, () => HttpResponse.json(customFieldsPage1)),
    );

    const result = await runIncremental(customFieldsSyncer, {
      db,
      client: makeTeamtailorClient(),
    });

    expect(result.recordsSynced).toBe(2);
    expect(result.rowErrors).toBe(0);

    const { data: rows, error } = await db
      .from('custom_fields')
      .select('teamtailor_id, api_name, field_type, owner_type, is_private, is_searchable')
      .in('teamtailor_id', ['465', '1458'])
      .order('teamtailor_id');
    expect(error).toBeNull();
    expect(rows).toHaveLength(2);
    // 465 (Asp salariales) — private text field
    expect(rows![0]!.api_name).toBe('asp-salariales');
    expect(rows![0]!.field_type).toBe('CustomField::Text');
    expect(rows![0]!.owner_type).toBe('Candidate');
    expect(rows![0]!.is_private).toBe(true);
    expect(rows![0]!.is_searchable).toBe(true);
    // 1458 (Último seguimiento) — public date field
    expect(rows![1]!.api_name).toBe('ltimo-seguimiento');
    expect(rows![1]!.field_type).toBe('CustomField::Date');
    expect(rows![1]!.is_private).toBe(false);

    const state = await readSyncState(db, 'custom-fields');
    expect(state.lastRunStatus).toBe('success');
    expect(state.recordsSynced).toBe(2);
  });

  it('is idempotent: running twice keeps the same 2 rows', async () => {
    server.use(
      http.get(`${BASE_URL}/custom-fields`, () => HttpResponse.json(customFieldsPage1)),
    );

    await runIncremental(customFieldsSyncer, { db, client: makeTeamtailorClient() });
    await runIncremental(customFieldsSyncer, { db, client: makeTeamtailorClient() });

    const { count } = await db
      .from('custom_fields')
      .select('*', { count: 'exact', head: true })
      .in('teamtailor_id', ['465', '1458']);
    expect(count).toBe(2);
  });

  it('rejects a resource missing required api-name attribute', async () => {
    const bad = {
      data: [
        {
          id: '999',
          type: 'custom-fields',
          attributes: {
            name: 'Incomplete',
            // missing api-name
            'field-type': 'CustomField::Text',
            'owner-type': 'Candidate',
          },
        },
        {
          id: '1000',
          type: 'custom-fields',
          attributes: {
            name: 'Good one',
            'api-name': 'good-one',
            'field-type': 'CustomField::Text',
            'owner-type': 'Candidate',
          },
        },
      ],
    };
    server.use(http.get(`${BASE_URL}/custom-fields`, () => HttpResponse.json(bad)));

    const result = await runIncremental(customFieldsSyncer, {
      db,
      client: makeTeamtailorClient(),
    });

    expect(result.recordsSynced).toBe(1);
    expect(result.rowErrors).toBe(1);

    const { data: errors } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_message')
      .eq('entity', 'custom-fields');
    expect(errors).toHaveLength(1);
    expect(errors![0]!.teamtailor_id).toBe('999');
  });
});
