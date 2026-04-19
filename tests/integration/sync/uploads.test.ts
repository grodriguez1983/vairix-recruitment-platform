/**
 * E2E test for runIncremental + makeUploadsSyncer.
 *
 * This hits the real local Supabase Storage (`candidate-cvs` bucket)
 * and the real `files` table, but mocks both:
 *   - Teamtailor JSON:API `/uploads` via MSW
 *   - Binary downloads from `binaries.test` via MSW (what
 *     `downloadAndStore` fetches via globalThis.fetch)
 *
 * Scenarios covered:
 *   - Happy path: two uploads resolve to files rows, binaries land
 *     in the bucket, orphan FK is logged to sync_errors.
 *   - Idempotency: re-running with the same binaries does NOT
 *     re-upload to Storage and does NOT invalidate parsed_text
 *     (content_hash-based skip).
 *   - Binary changed: same teamtailor_id but different bytes →
 *     storage re-uploads AND parsed_text is reset to null.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runIncremental } from '../../../src/lib/sync/run';
import { makeUploadsSyncer } from '../../../src/lib/sync/uploads';
import { BUCKET as CV_BUCKET } from '../../../src/lib/cv/downloader';
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
const uploadsPage1 = JSON.parse(
  readFileSync(path.join(fixturesDir, 'uploads-page-1.json'), 'utf-8'),
);

const UPLOAD_IDS = ['30001', '30002', '30003'];
const CANDIDATE_TT_ID = '9001';

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

function binaryResponse(bytes: Uint8Array): Response {
  const ab = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(ab).set(bytes);
  return new Response(ab, { status: 200 });
}

const server = setupServer();
beforeAll(() =>
  server.listen({
    onUnhandledRequest: (req, print) => {
      const u = req.url;
      if (u.startsWith(BASE_URL) || u.startsWith('https://binaries.test/')) print.error();
    },
  }),
);
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

describe('runIncremental + uploadsSyncer', () => {
  const db = svc();
  let candidateId: string;

  beforeEach(async () => {
    // Clean any prior state from this test.
    await db.from('files').delete().in('teamtailor_id', UPLOAD_IDS);
    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);

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
    candidateId = cand!.id as string;

    // Purge any storage objects from a prior run (by candidate prefix).
    const storage = db.storage.from(CV_BUCKET);
    const { data: priorObjs } = await storage.list(candidateId);
    if (priorObjs && priorObjs.length > 0) {
      await storage.remove(priorObjs.map((o) => `${candidateId}/${o.name}`));
    }

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
      .eq('entity', 'files');
    await db.from('sync_errors').delete().eq('entity', 'uploads');
  });

  it('uploads two binaries, records orphan, and persists content_hash', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]);
    const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);

    server.use(
      http.get(`${BASE_URL}/uploads`, () => HttpResponse.json(uploadsPage1)),
      http.get('https://binaries.test/cvs/30001.pdf', () => binaryResponse(pdfBytes)),
      http.get('https://binaries.test/cvs/30002.docx', () => binaryResponse(docxBytes)),
      // 30003 has an orphan candidate → downloader never called; no handler needed.
    );

    const syncer = makeUploadsSyncer({ storage: db.storage.from(CV_BUCKET) });
    const result = await runIncremental(syncer, { db, client: makeTeamtailorClient() });

    expect(result.recordsSynced).toBe(2);

    const { data: files } = await db
      .from('files')
      .select(
        'teamtailor_id, candidate_id, file_type, content_hash, is_internal, kind, parsed_text',
      )
      .in('teamtailor_id', UPLOAD_IDS)
      .order('teamtailor_id');
    expect(files).toHaveLength(2);
    expect(files![0]).toMatchObject({
      teamtailor_id: '30001',
      candidate_id: candidateId,
      file_type: 'pdf',
      is_internal: true,
      kind: 'cv',
      parsed_text: null,
    });
    expect(files![0]!.content_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(files![1]).toMatchObject({
      teamtailor_id: '30002',
      candidate_id: candidateId,
      file_type: 'docx',
      is_internal: false,
      kind: 'cv',
    });

    // Orphan logged.
    const { data: errs } = await db
      .from('sync_errors')
      .select('teamtailor_id, error_code')
      .eq('entity', 'uploads');
    expect(errs).toHaveLength(1);
    expect(errs![0]).toMatchObject({ teamtailor_id: '30003', error_code: 'OrphanFK' });

    // Storage actually received the bytes.
    const { data: listed } = await db.storage.from(CV_BUCKET).list(candidateId);
    expect(listed).toBeTruthy();
    expect(listed!.length).toBe(2);
  });

  it('is idempotent when binaries are unchanged (no re-upload, parsed_text preserved)', async () => {
    const pdfBytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]);
    const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);

    // Return the SAME bytes on every binary fetch; TT also returns the same page.
    server.use(
      http.get(`${BASE_URL}/uploads`, () => HttpResponse.json(uploadsPage1)),
      http.get('https://binaries.test/cvs/30001.pdf', () => binaryResponse(pdfBytes)),
      http.get('https://binaries.test/cvs/30002.docx', () => binaryResponse(docxBytes)),
    );

    const syncer = makeUploadsSyncer({ storage: db.storage.from(CV_BUCKET) });
    await runIncremental(syncer, { db, client: makeTeamtailorClient() });

    // Simulate the CV parser having processed the files.
    await db
      .from('files')
      .update({ parsed_text: 'parsed content', parsed_at: new Date().toISOString() })
      .in('teamtailor_id', ['30001', '30002']);

    // Reset sync_state so the next run fires again.
    await db
      .from('sync_state')
      .update({ last_run_status: 'idle', last_synced_at: null })
      .eq('entity', 'files');

    await runIncremental(syncer, { db, client: makeTeamtailorClient() });

    const { data: filesAfter } = await db
      .from('files')
      .select('teamtailor_id, parsed_text')
      .in('teamtailor_id', ['30001', '30002'])
      .order('teamtailor_id');
    // parsed_text survived — the syncer skipped the DB write for
    // unchanged binaries.
    expect(filesAfter![0]!.parsed_text).toBe('parsed content');
    expect(filesAfter![1]!.parsed_text).toBe('parsed content');
  });

  it('re-uploads and resets parser state when the binary changes', async () => {
    const pdfV1 = new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4, 5]);
    const pdfV2 = new Uint8Array([0x25, 0x50, 0x44, 0x46, 99, 99, 99]);
    const docxBytes = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 9, 8, 7]);

    // First run serves v1.
    server.use(
      http.get(`${BASE_URL}/uploads`, () => HttpResponse.json(uploadsPage1)),
      http.get('https://binaries.test/cvs/30001.pdf', () => binaryResponse(pdfV1)),
      http.get('https://binaries.test/cvs/30002.docx', () => binaryResponse(docxBytes)),
    );
    const syncer = makeUploadsSyncer({ storage: db.storage.from(CV_BUCKET) });
    await runIncremental(syncer, { db, client: makeTeamtailorClient() });

    // Simulate parser output.
    await db
      .from('files')
      .update({ parsed_text: 'v1 parsed', parsed_at: new Date().toISOString() })
      .eq('teamtailor_id', '30001');

    const { data: beforeRow } = await db
      .from('files')
      .select('content_hash')
      .eq('teamtailor_id', '30001')
      .single();
    const hashV1 = beforeRow!.content_hash as string;

    // Second run: serve v2 bytes for 30001, same for 30002.
    server.resetHandlers();
    server.use(
      http.get(`${BASE_URL}/uploads`, () => HttpResponse.json(uploadsPage1)),
      http.get('https://binaries.test/cvs/30001.pdf', () => binaryResponse(pdfV2)),
      http.get('https://binaries.test/cvs/30002.docx', () => binaryResponse(docxBytes)),
    );
    await db
      .from('sync_state')
      .update({ last_run_status: 'idle', last_synced_at: null })
      .eq('entity', 'files');
    await runIncremental(syncer, { db, client: makeTeamtailorClient() });

    const { data: afterRow } = await db
      .from('files')
      .select('content_hash, parsed_text')
      .eq('teamtailor_id', '30001')
      .single();
    expect(afterRow!.content_hash).not.toBe(hashV1);
    expect(afterRow!.parsed_text).toBeNull();
  });
});
