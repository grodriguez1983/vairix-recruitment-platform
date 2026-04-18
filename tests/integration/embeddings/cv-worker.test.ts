/**
 * Integration tests for the cv-source embeddings worker (F3-001).
 *
 * Runs against real Supabase with the stub provider (no OpenAI).
 * Covers:
 *   - First run: embeds candidates whose files have parsed_text,
 *     skips candidates without any CV text.
 *   - Only the most recent parsed CV contributes to the embedding —
 *     older CVs must not leak in.
 *   - Idempotence: re-run with no changes ⇒ zero regeneration.
 *   - Updating parsed_text of the latest CV invalidates the cache.
 *   - Model change invalidates every affected row.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runCvEmbeddings } from '../../../src/lib/embeddings/cv-worker';
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
const PREFIX = 'cvembtest-';
const CAND_TT_IDS = [`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`];

interface SeedResult {
  ids: Record<string, string>;
}

async function cleanup(): Promise<void> {
  // files cascade from candidates; embeddings too.
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);
}

async function seed(): Promise<SeedResult> {
  await cleanup();

  //   a — two files: older + newer (only newer should be embedded)
  //   b — one file with parsed_text
  //   c — one file but parsed_text is null (should be skipped)
  const { data: cands, error: cErr } = await db
    .from('candidates')
    .insert([
      {
        teamtailor_id: `${PREFIX}a`,
        first_name: 'Ada',
        last_name: 'Cv',
        email: `${PREFIX}a@example.test`,
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}b`,
        first_name: 'Basil',
        last_name: 'Cv',
        email: `${PREFIX}b@example.test`,
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}c`,
        first_name: 'Cleo',
        last_name: 'Cv',
        email: `${PREFIX}c@example.test`,
        raw_data: {},
      },
    ])
    .select('id, teamtailor_id');
  if (cErr) throw cErr;
  const ids: Record<string, string> = {};
  for (const c of cands ?? []) ids[c.teamtailor_id as string] = c.id as string;

  const { error: fErr } = await db.from('files').insert([
    {
      candidate_id: ids[`${PREFIX}a`]!,
      storage_path: `${PREFIX}a/old.pdf`,
      parsed_text: 'Older CV — junior frontend.',
      parsed_at: '2023-01-01T10:00:00Z',
      raw_data: {},
    },
    {
      candidate_id: ids[`${PREFIX}a`]!,
      storage_path: `${PREFIX}a/new.pdf`,
      parsed_text: 'Newer CV — senior backend engineer.',
      parsed_at: '2024-06-01T10:00:00Z',
      raw_data: {},
    },
    {
      candidate_id: ids[`${PREFIX}b`]!,
      storage_path: `${PREFIX}b/only.pdf`,
      parsed_text: 'Basil CV — go and distributed systems.',
      parsed_at: '2024-03-01T10:00:00Z',
      raw_data: {},
    },
    {
      candidate_id: ids[`${PREFIX}c`]!,
      storage_path: `${PREFIX}c/unparsed.pdf`,
      parsed_text: null,
      parsed_at: null,
      raw_data: {},
    },
  ]);
  if (fErr) throw fErr;

  return { ids };
}

describe('runCvEmbeddings (cv source)', () => {
  afterAll(cleanup);

  let ids: Record<string, string>;

  beforeEach(async () => {
    const s = await seed();
    ids = s.ids;
  });

  it('first run: embeds candidates with parsed CVs, skips those without', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    const res = await runCvEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.processed).toBe(2); // a, b
    expect(res.skipped).toBe(1); // c
    expect(res.regenerated).toBe(2);
    expect(res.reused).toBe(0);

    const { data } = await db
      .from('embeddings')
      .select('candidate_id, content, model')
      .eq('source_type', 'cv')
      .in('candidate_id', Object.values(ids));

    expect((data ?? []).length).toBe(2);
    const rowA = (data ?? []).find((r) => r.candidate_id === ids[`${PREFIX}a`]);
    expect(rowA?.content).toContain('Newer CV');
    expect(rowA?.content).not.toContain('Older CV');
  });

  it('is idempotent: second run with no changes → zero regeneration', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    await runCvEmbeddings(db, provider, { candidateIds: Object.values(ids) });
    const res = await runCvEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.processed).toBe(2);
    expect(res.regenerated).toBe(0);
    expect(res.reused).toBe(2);
  });

  it('regenerates when a newer CV is added', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    await runCvEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    const { error } = await db.from('files').insert({
      candidate_id: ids[`${PREFIX}a`]!,
      storage_path: `${PREFIX}a/newest.pdf`,
      parsed_text: 'Newest CV — staff engineer, platform lead.',
      parsed_at: '2024-09-01T10:00:00Z',
      raw_data: {},
    });
    if (error) throw error;

    const res = await runCvEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.regenerated).toBe(1); // only a
    expect(res.reused).toBe(1); // b unchanged
  });

  it('regenerates everything when the provider model changes', async () => {
    const v1 = createStubProvider({ model: 'stub-v1', dim: 1536 });
    await runCvEmbeddings(db, v1, { candidateIds: Object.values(ids) });

    const v2 = createStubProvider({ model: 'stub-v2', dim: 1536 });
    const res = await runCvEmbeddings(db, v2, { candidateIds: Object.values(ids) });

    expect(res.regenerated).toBe(2);
    expect(res.reused).toBe(0);

    const { data } = await db
      .from('embeddings')
      .select('model')
      .eq('source_type', 'cv')
      .in('candidate_id', Object.values(ids));
    for (const r of data ?? []) expect(r.model).toBe('stub-v2');
  });
});
