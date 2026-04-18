/**
 * Pagination regression test for the shared embeddings worker runtime.
 *
 * The old per-source workers used `.limit(batchSize)` as a hard cap:
 * with 501 active candidates and the default batchSize=500, the 501st
 * candidate would never be embedded. The shared runtime must
 * paginate until exhaustion. This test seeds more candidates than
 * one page and asserts every one is embedded.
 *
 * Uses `batchSize: 3` to keep the fixture small while still forcing
 * multiple pages.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runNotesEmbeddings } from '../../../src/lib/embeddings/notes-worker';
import { createStubProvider } from '../../../src/lib/embeddings/stub-provider';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const db = svc();
const PREFIX = 'pagtest-';
const COUNT = 7; // > 2 pages with batchSize=3

async function cleanup(): Promise<void> {
  await db
    .from('candidates')
    .delete()
    .in(
      'teamtailor_id',
      Array.from({ length: COUNT }, (_, i) => `${PREFIX}${i}`),
    );
}

describe('runEmbeddingsWorker pagination', () => {
  const ids: string[] = [];

  beforeAll(async () => {
    await cleanup();
    const rows = Array.from({ length: COUNT }, (_, i) => ({
      teamtailor_id: `${PREFIX}${i}`,
      first_name: 'P',
      last_name: `Cand${i}`,
      email: `${PREFIX}${i}@example.test`,
      raw_data: {},
    }));
    const { data, error } = await db.from('candidates').insert(rows).select('id');
    if (error) throw error;
    for (const r of data ?? []) ids.push(r.id as string);

    // Every candidate needs a note so the worker has something to embed.
    const notes = ids.map((cid, i) => ({
      candidate_id: cid,
      body: `Candidate ${i} screening note.`,
      created_at: '2024-01-01T10:00:00Z',
      raw_data: {},
    }));
    const { error: nErr } = await db.from('notes').insert(notes);
    if (nErr) throw nErr;
  });

  afterAll(cleanup);

  it('processes every candidate when total > batchSize', async () => {
    const provider = createStubProvider({ model: 'stub-pag', dim: 1536 });
    const res = await runNotesEmbeddings(db, provider, {
      candidateIds: ids,
      batchSize: 3,
    });

    expect(res.processed).toBe(COUNT);
    expect(res.skipped).toBe(0);
    expect(res.regenerated).toBe(COUNT);

    const { data } = await db
      .from('embeddings')
      .select('candidate_id')
      .eq('source_type', 'notes')
      .in('candidate_id', ids);
    const embeddedIds = new Set((data ?? []).map((r) => r.candidate_id as string));
    for (const id of ids) expect(embeddedIds.has(id)).toBe(true);
  });
});
