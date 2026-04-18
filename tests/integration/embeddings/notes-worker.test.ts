/**
 * Integration tests for the notes-source embeddings worker.
 *
 * Runs against real Supabase with the stub provider (no OpenAI).
 * Covers:
 *   - First run: embeds candidates that have notes, skips candidates
 *     without any notes.
 *   - Idempotence: re-run with no changes ⇒ zero regeneration.
 *   - Adding a note invalidates the cache (hash changes ⇒ re-embed).
 *   - Model change invalidates the cache for every affected row.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
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
const PREFIX = 'notesembtest-';
const CAND_TT_IDS = [`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`];

interface SeedResult {
  ids: Record<string, string>;
}

async function cleanup(): Promise<void> {
  // Notes cascade from candidates; embeddings do too.
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);
}

async function seed(): Promise<SeedResult> {
  await cleanup();

  // Three candidates:
  //   a — two notes (oldest + newest)
  //   b — one note
  //   c — no notes at all (should be skipped)
  const { data: cands, error: cErr } = await db
    .from('candidates')
    .insert([
      {
        teamtailor_id: `${PREFIX}a`,
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: `${PREFIX}a@example.test`,
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}b`,
        first_name: 'Basil',
        last_name: 'Hume',
        email: `${PREFIX}b@example.test`,
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}c`,
        first_name: 'Cleo',
        last_name: 'Ng',
        email: `${PREFIX}c@example.test`,
        raw_data: {},
      },
    ])
    .select('id, teamtailor_id');
  if (cErr) throw cErr;
  const ids: Record<string, string> = {};
  for (const c of cands ?? []) {
    ids[c.teamtailor_id as string] = c.id as string;
  }

  const { error: nErr } = await db.from('notes').insert([
    {
      candidate_id: ids[`${PREFIX}a`]!,
      body: 'Initial screen: solid fundamentals.',
      created_at: '2024-01-01T10:00:00Z',
      raw_data: {},
    },
    {
      candidate_id: ids[`${PREFIX}a`]!,
      body: 'Tech interview: great systems design.',
      created_at: '2024-02-15T10:00:00Z',
      raw_data: {},
    },
    {
      candidate_id: ids[`${PREFIX}b`]!,
      body: 'Referred by team lead; strong Go experience.',
      created_at: '2024-03-01T10:00:00Z',
      raw_data: {},
    },
  ]);
  if (nErr) throw nErr;

  return { ids };
}

describe('runNotesEmbeddings (notes source)', () => {
  afterAll(cleanup);

  let ids: Record<string, string>;

  beforeEach(async () => {
    const s = await seed();
    ids = s.ids;
  });

  it('first run: embeds candidates with notes, skips those without', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    const res = await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.processed).toBe(2); // a, b
    expect(res.skipped).toBe(1); // c (no notes)
    expect(res.regenerated).toBe(2);
    expect(res.reused).toBe(0);

    const { data } = await db
      .from('embeddings')
      .select('candidate_id, source_type, model, content_hash, content')
      .eq('source_type', 'notes')
      .in('candidate_id', Object.values(ids));

    expect((data ?? []).length).toBe(2);
    const rowA = (data ?? []).find((r) => r.candidate_id === ids[`${PREFIX}a`]);
    expect(rowA?.model).toBe('stub-test');
    expect(rowA?.content).toContain('Initial screen');
    expect(rowA?.content).toContain('Tech interview');
    // Chronological order: Initial screen comes before Tech interview.
    expect((rowA?.content as string).indexOf('Initial screen')).toBeLessThan(
      (rowA?.content as string).indexOf('Tech interview'),
    );
  });

  it('is idempotent: second run with no changes → zero regeneration', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });
    const res = await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.processed).toBe(2);
    expect(res.regenerated).toBe(0);
    expect(res.reused).toBe(2);
  });

  it('regenerates when a new note is added', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    const { error } = await db.from('notes').insert({
      candidate_id: ids[`${PREFIX}a`]!,
      body: 'Final round: offered.',
      created_at: '2024-03-20T10:00:00Z',
      raw_data: {},
    });
    if (error) throw error;

    const res = await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.regenerated).toBe(1); // only a
    expect(res.reused).toBe(1); // b unchanged
  });

  it('regenerates everything when the provider model changes', async () => {
    const v1 = createStubProvider({ model: 'stub-v1', dim: 1536 });
    await runNotesEmbeddings(db, v1, { candidateIds: Object.values(ids) });

    const v2 = createStubProvider({ model: 'stub-v2', dim: 1536 });
    const res = await runNotesEmbeddings(db, v2, { candidateIds: Object.values(ids) });

    expect(res.regenerated).toBe(2);
    expect(res.reused).toBe(0);

    const { data } = await db
      .from('embeddings')
      .select('model')
      .eq('source_type', 'notes')
      .in('candidate_id', Object.values(ids));
    for (const r of data ?? []) expect(r.model).toBe('stub-v2');
  });
});
