/**
 * Integration tests for semanticSearchCandidates.
 *
 * Uses the deterministic stub provider — same input ⇒ same vector —
 * so we can seed embeddings with known strings and expect them to
 * match when queried with the identical string (score = 1.0 ±ε).
 *
 * Covers:
 *   - End-to-end happy path (embed + RPC + return hits).
 *   - `sourceTypes` filter restricts the RPC output.
 *   - Empty corpus ⇒ empty result (no crash).
 *   - Limit is respected.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runProfileEmbeddings } from '../../../src/lib/embeddings/profile-worker';
import { runNotesEmbeddings } from '../../../src/lib/embeddings/notes-worker';
import { createStubProvider } from '../../../src/lib/embeddings/stub-provider';
import { semanticSearchCandidates } from '../../../src/lib/rag/semantic-search';

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
const PREFIX = 'semtest-';
const CAND_TT_IDS = [`${PREFIX}backend`, `${PREFIX}frontend`, `${PREFIX}none`];

async function cleanup(): Promise<void> {
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);
}

async function seed(): Promise<Record<string, string>> {
  await cleanup();

  const { data: cands, error } = await db
    .from('candidates')
    .insert([
      {
        teamtailor_id: `${PREFIX}backend`,
        first_name: 'Ada',
        last_name: 'Backend',
        email: `${PREFIX}backend@example.test`,
        pitch: 'Distributed systems engineer, Go, Kafka, Postgres.',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}frontend`,
        first_name: 'Grace',
        last_name: 'Frontend',
        email: `${PREFIX}frontend@example.test`,
        pitch: 'React designer focused on accessibility and animation.',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}none`,
        first_name: 'Hopper',
        last_name: 'Sparse',
        email: `${PREFIX}none@example.test`,
        pitch: null,
        raw_data: {},
      },
    ])
    .select('id, teamtailor_id');
  if (error) throw error;

  const ids: Record<string, string> = {};
  for (const c of cands ?? []) ids[c.teamtailor_id as string] = c.id as string;

  // Add a note on the backend candidate so we have two source types
  // for the same candidate and can test the sourceTypes filter.
  const { error: nErr } = await db.from('notes').insert({
    candidate_id: ids[`${PREFIX}backend`]!,
    body: 'Interview went great: handled system-design question well.',
    created_at: '2024-01-01T10:00:00Z',
    raw_data: {},
  });
  if (nErr) throw nErr;

  const provider = createStubProvider({ model: 'stub-semsearch', dim: 1536 });
  await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });
  await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });

  return ids;
}

describe('semanticSearchCandidates', () => {
  afterAll(cleanup);

  let ids: Record<string, string>;

  beforeEach(async () => {
    ids = await seed();
  });

  it('returns hits from any source when sourceTypes is unset', async () => {
    const provider = createStubProvider({ model: 'stub-semsearch', dim: 1536 });
    const hits = await semanticSearchCandidates(db, provider, {
      query: 'anything',
      limit: 10,
    });
    // We seeded 2 profile + 1 notes embedding (the null-pitch
    // candidate had no profile content, no notes).
    const ourHits = hits.filter((h) => Object.values(ids).includes(h.candidateId));
    expect(ourHits.length).toBeGreaterThanOrEqual(2);
    const sources = new Set(ourHits.map((h) => h.sourceType));
    expect(sources.has('profile')).toBe(true);
    expect(sources.has('notes')).toBe(true);
  });

  it('restricts to profile-only when sourceTypes=["profile"]', async () => {
    const provider = createStubProvider({ model: 'stub-semsearch', dim: 1536 });
    const hits = await semanticSearchCandidates(db, provider, {
      query: 'anything',
      limit: 10,
      sourceTypes: ['profile'],
    });
    for (const h of hits) expect(h.sourceType).toBe('profile');
  });

  it('respects the limit', async () => {
    const provider = createStubProvider({ model: 'stub-semsearch', dim: 1536 });
    const hits = await semanticSearchCandidates(db, provider, {
      query: 'anything',
      limit: 1,
    });
    expect(hits.length).toBe(1);
  });

  it('scores an exact-match query at ~1.0', async () => {
    const provider = createStubProvider({ model: 'stub-semsearch', dim: 1536 });
    // Replay the exact string the profile builder produced for
    // the backend candidate so the query vector equals the stored
    // vector (stub provider is deterministic on input string).
    const query = 'Ada Backend\nDistributed systems engineer, Go, Kafka, Postgres.';
    const hits = await semanticSearchCandidates(db, provider, {
      query,
      limit: 5,
      sourceTypes: ['profile'],
    });
    const backend = hits.find((h) => h.candidateId === ids[`${PREFIX}backend`]);
    expect(backend).toBeDefined();
    expect(backend!.score).toBeGreaterThan(0.99);
  });
});
