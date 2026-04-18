/**
 * Integration tests for the profile-source embeddings worker.
 *
 * Runs the worker against real Supabase with the stub provider
 * (no OpenAI calls). Covers:
 *   - First run: creates embeddings for candidates with content,
 *     skips empty candidates.
 *   - Idempotence: re-run with no changes ⇒ zero regeneration.
 *   - Content change invalidates cache (pitch edited ⇒ re-embedded).
 *   - Model change invalidates cache (different provider.model ⇒
 *     all rows re-embedded, because the hash includes the model).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runProfileEmbeddings } from '../../../src/lib/embeddings/profile-worker';
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
const PREFIX = 'embtest-';
const CAND_TT_IDS = [`${PREFIX}a`, `${PREFIX}b`, `${PREFIX}c`];

interface SeedResult {
  ids: Record<string, string>;
}

async function cleanup(): Promise<void> {
  // Embeddings cascade from candidates.
  await db
    .from('candidate_tags')
    .delete()
    .in(
      'tag_id',
      ((await db.from('tags').select('id').like('name', `${PREFIX}%`)).data ?? []).map(
        (t) => t.id as string,
      ),
    );
  await db.from('tags').delete().like('name', `${PREFIX}%`);
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);
}

async function seed(): Promise<SeedResult> {
  await cleanup();

  // Three candidates:
  //   a — full profile (first/last + pitch + tags)
  //   b — name only (no pitch, no tags)
  //   c — nothing usable (empty)
  const { data: cands, error: cErr } = await db
    .from('candidates')
    .insert([
      {
        teamtailor_id: `${PREFIX}a`,
        first_name: 'Ada',
        last_name: 'Lovelace',
        email: `${PREFIX}a@example.test`,
        pitch: 'Senior backend engineer with distributed systems experience.',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}b`,
        first_name: 'Basil',
        last_name: 'Hume',
        email: `${PREFIX}b@example.test`,
        pitch: null,
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}c`,
        first_name: null,
        last_name: null,
        email: `${PREFIX}c@example.test`,
        pitch: null,
        raw_data: {},
      },
    ])
    .select('id, teamtailor_id');
  if (cErr) throw cErr;
  const ids: Record<string, string> = {};
  for (const c of cands ?? []) {
    ids[c.teamtailor_id as string] = c.id as string;
  }

  // Tags for candidate A.
  const { data: tags, error: tErr } = await db
    .from('tags')
    .insert([{ name: `${PREFIX}go` }, { name: `${PREFIX}kafka` }])
    .select('id');
  if (tErr) throw tErr;
  const tagIds = (tags ?? []).map((t) => t.id as string);

  await db
    .from('candidate_tags')
    .insert(tagIds.map((tag_id) => ({ candidate_id: ids[`${PREFIX}a`]!, tag_id })));

  return { ids };
}

describe('runProfileEmbeddings (profile source)', () => {
  afterAll(cleanup);

  let ids: Record<string, string>;

  beforeEach(async () => {
    const s = await seed();
    ids = s.ids;
  });

  it('first run: embeds candidates with usable content, skips empty', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    const res = await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.processed).toBe(2); // a, b
    expect(res.skipped).toBe(1); // c (no content)
    expect(res.regenerated).toBe(2);
    expect(res.reused).toBe(0);

    const { data } = await db
      .from('embeddings')
      .select('candidate_id, source_type, model, content_hash, embedding')
      .eq('source_type', 'profile')
      .in('candidate_id', Object.values(ids));

    expect((data ?? []).length).toBe(2);
    const row = (data ?? []).find((r) => r.candidate_id === ids[`${PREFIX}a`]);
    expect(row?.model).toBe('stub-test');
    expect(row?.content_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is idempotent: second run with no changes → zero regeneration', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });
    const res = await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.processed).toBe(2);
    expect(res.regenerated).toBe(0);
    expect(res.reused).toBe(2);
  });

  it('regenerates when content changes (pitch edited)', async () => {
    const provider = createStubProvider({ model: 'stub-test', dim: 1536 });
    await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    await db
      .from('candidates')
      .update({ pitch: 'Now specializing in real-time streaming.' })
      .eq('id', ids[`${PREFIX}a`]!);

    const res = await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });

    expect(res.regenerated).toBe(1); // only a
    expect(res.reused).toBe(1); // b unchanged
  });

  it('regenerates everything when the provider model changes', async () => {
    const v1 = createStubProvider({ model: 'stub-v1', dim: 1536 });
    await runProfileEmbeddings(db, v1, { candidateIds: Object.values(ids) });

    const v2 = createStubProvider({ model: 'stub-v2', dim: 1536 });
    const res = await runProfileEmbeddings(db, v2, { candidateIds: Object.values(ids) });

    expect(res.regenerated).toBe(2); // both a and b, since hash includes model
    expect(res.reused).toBe(0);

    const { data } = await db
      .from('embeddings')
      .select('model')
      .eq('source_type', 'profile')
      .in('candidate_id', Object.values(ids));
    for (const r of data ?? []) expect(r.model).toBe('stub-v2');
  });
});
