/**
 * E2E test for the CV parse worker against local Supabase + Storage.
 *
 * Wires the real `listPending`/`download`/`update` bindings that the
 * CLI uses (`src/scripts/parse-cvs.ts`), but with parser stubs so we
 * don't need real PDFs/DOCXs. The point of this test is NOT to
 * validate pdf-parse/mammoth (parse.test.ts does that) — it's to
 * prove that:
 *   - The SQL predicate picks the right rows (pending only).
 *   - Storage.download() round-trips bytes.
 *   - Worker updates persist.
 *   - A row with parse_error set is NOT reprocessed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runCvParseWorker } from '../../../src/lib/cv/parse-worker';
import { BUCKET as CV_BUCKET } from '../../../src/lib/cv/downloader';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const CANDIDATE_TT_ID = 'parse-worker-test';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function workerDeps(
  db: SupabaseClient,
  parser: {
    parsePdf: (buf: Buffer) => Promise<{ text: string }>;
    parseDocx: (buf: Buffer) => Promise<{ value: string }>;
  },
) {
  const bucket = db.storage.from(CV_BUCKET);
  return {
    listPending: async (limit: number) => {
      const { data, error } = await db
        .from('files')
        .select('id, storage_path, file_type')
        .is('deleted_at', null)
        .is('parsed_text', null)
        .is('parse_error', null)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (error) throw new Error(error.message);
      return (data ?? []) as Array<{ id: string; storage_path: string; file_type: string }>;
    },
    download: async (path: string) => {
      const { data, error } = await bucket.download(path);
      if (error || !data) throw new Error(error?.message ?? 'no data');
      return Buffer.from(await data.arrayBuffer());
    },
    update: async (id: string, patch: Record<string, unknown>) => {
      const { error } = await db.from('files').update(patch).eq('id', id);
      if (error) throw new Error(error.message);
    },
    parser,
  };
}

describe('runCvParseWorker (integration)', () => {
  const db = svc();
  let candidateId: string;
  const storagePaths: string[] = [];

  beforeEach(async () => {
    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);
    const { data: cand } = await db
      .from('candidates')
      .insert({
        teamtailor_id: CANDIDATE_TT_ID,
        first_name: 'Parse',
        last_name: 'Worker',
        email: 'parse-worker@example.test',
        raw_data: {},
      })
      .select('id')
      .single();
    candidateId = cand!.id as string;
    storagePaths.length = 0;
  });

  afterEach(async () => {
    // Remove any storage objects we created (by collected paths).
    if (storagePaths.length > 0) {
      await db.storage.from(CV_BUCKET).remove(storagePaths);
    }
    await db.from('files').delete().eq('candidate_id', candidateId);
    await db.from('candidates').delete().eq('id', candidateId);
  });

  it('parses pending rows, persists text, and ignores already-terminal rows', async () => {
    const bucket = db.storage.from(CV_BUCKET);
    const pdfPath = `${candidateId}/pending.pdf`;
    const docxPath = `${candidateId}/pending.docx`;
    const donePath = `${candidateId}/done.pdf`;
    const erroredPath = `${candidateId}/errored.pdf`;
    storagePaths.push(pdfPath, docxPath, donePath, erroredPath);

    await bucket.upload(pdfPath, Buffer.from('pdf-bytes-pending'), {
      contentType: 'application/pdf',
      upsert: true,
    });
    await bucket.upload(docxPath, Buffer.from('docx-bytes-pending'), {
      contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      upsert: true,
    });
    await bucket.upload(donePath, Buffer.from('dont-parse-me'), {
      contentType: 'application/pdf',
      upsert: true,
    });
    await bucket.upload(erroredPath, Buffer.from('dont-retry-me'), {
      contentType: 'application/pdf',
      upsert: true,
    });

    // Seed files rows: 2 pending + 1 already parsed + 1 already errored.
    const { data: rows } = await db
      .from('files')
      .insert([
        {
          candidate_id: candidateId,
          storage_path: pdfPath,
          file_type: 'pdf',
          file_size_bytes: 17,
          content_hash: 'a'.repeat(64),
          kind: 'cv',
          raw_data: {},
        },
        {
          candidate_id: candidateId,
          storage_path: docxPath,
          file_type: 'docx',
          file_size_bytes: 18,
          content_hash: 'b'.repeat(64),
          kind: 'cv',
          raw_data: {},
        },
        {
          candidate_id: candidateId,
          storage_path: donePath,
          file_type: 'pdf',
          file_size_bytes: 13,
          content_hash: 'c'.repeat(64),
          kind: 'cv',
          raw_data: {},
          parsed_text: 'already parsed',
          parsed_at: new Date().toISOString(),
        },
        {
          candidate_id: candidateId,
          storage_path: erroredPath,
          file_type: 'pdf',
          file_size_bytes: 14,
          content_hash: 'd'.repeat(64),
          kind: 'cv',
          raw_data: {},
          parse_error: 'likely_scanned',
          parsed_at: new Date().toISOString(),
        },
      ])
      .select('id, storage_path');

    const parsePdf = vi.fn().mockImplementation(async (buf: Buffer) => ({
      text: `PDF TEXT >> ${buf.toString('utf8').repeat(40)}`,
    }));
    const parseDocx = vi.fn().mockImplementation(async (buf: Buffer) => ({
      value: `DOCX TEXT >> ${buf.toString('utf8')}`,
    }));

    const result = await runCvParseWorker(workerDeps(db, { parsePdf, parseDocx }), {
      batchSize: 50,
    });
    expect(result).toEqual({ processed: 2, parsed: 2, errored: 0 });

    // Terminal rows untouched.
    const doneRow = rows!.find((r) => r.storage_path === donePath)!;
    const erroredRow = rows!.find((r) => r.storage_path === erroredPath)!;
    const { data: doneAfter } = await db
      .from('files')
      .select('parsed_text, parse_error')
      .eq('id', doneRow.id)
      .single();
    expect(doneAfter!.parsed_text).toBe('already parsed');
    expect(doneAfter!.parse_error).toBeNull();
    const { data: erroredAfter } = await db
      .from('files')
      .select('parsed_text, parse_error')
      .eq('id', erroredRow.id)
      .single();
    expect(erroredAfter!.parse_error).toBe('likely_scanned');
    expect(erroredAfter!.parsed_text).toBeNull();

    // Pending rows updated.
    const pdfRow = rows!.find((r) => r.storage_path === pdfPath)!;
    const docxRow = rows!.find((r) => r.storage_path === docxPath)!;
    const { data: pdfAfter } = await db
      .from('files')
      .select('parsed_text, parse_error, parsed_at')
      .eq('id', pdfRow.id)
      .single();
    expect(pdfAfter!.parsed_text).toContain('PDF TEXT >>');
    expect(pdfAfter!.parse_error).toBeNull();
    expect(pdfAfter!.parsed_at).not.toBeNull();
    const { data: docxAfter } = await db
      .from('files')
      .select('parsed_text, parse_error')
      .eq('id', docxRow.id)
      .single();
    expect(docxAfter!.parsed_text).toContain('DOCX TEXT >>');
    expect(docxAfter!.parse_error).toBeNull();

    // Re-running picks up nothing.
    parsePdf.mockClear();
    parseDocx.mockClear();
    const result2 = await runCvParseWorker(workerDeps(db, { parsePdf, parseDocx }), {
      batchSize: 50,
    });
    expect(result2).toEqual({ processed: 0, parsed: 0, errored: 0 });
    expect(parsePdf).not.toHaveBeenCalled();
    expect(parseDocx).not.toHaveBeenCalled();
  });
});
