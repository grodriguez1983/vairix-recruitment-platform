/**
 * Integration tests for hybridSearchCandidates (F3-003, UC-01).
 *
 * Seeds a small pool of candidates with applications in known
 * statuses and embeddings via the deterministic stub provider,
 * then exercises the three modes:
 *   - hybrid: query + filters → semantic rerank over filtered ids
 *   - structured: filters only (no query) → candidate_ids returned,
 *     matches empty
 *   - empty: filters match nothing → short-circuit, no RPC call
 *
 * Also verifies that candidates outside the filter set never leak
 * into the ranked output (the key guarantee for UC-01: recruiter
 * searching "senior backend" within status=rejected must not see
 * active candidates).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { runNotesEmbeddings } from '../../../src/lib/embeddings/notes-worker';
import { runProfileEmbeddings } from '../../../src/lib/embeddings/profile-worker';
import { createStubProvider } from '../../../src/lib/embeddings/stub-provider';
import { hybridSearchCandidates } from '../../../src/lib/rag/hybrid-search';

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
const PREFIX = 'hybtest-';
const CAND_TT_IDS = [
  `${PREFIX}rejected-backend`,
  `${PREFIX}rejected-frontend`,
  `${PREFIX}active-backend`,
];
const JOB_TT_ID = `${PREFIX}job`;

async function cleanup(): Promise<void> {
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);
  await db.from('jobs').delete().eq('teamtailor_id', JOB_TT_ID);
}

async function seed(): Promise<Record<string, string>> {
  await cleanup();

  const { data: job, error: jErr } = await db
    .from('jobs')
    .insert({ teamtailor_id: JOB_TT_ID, title: `${PREFIX}job`, status: 'open' })
    .select('id')
    .single();
  if (jErr) throw jErr;
  const jobId = job.id as string;

  const { data: cands, error: cErr } = await db
    .from('candidates')
    .insert([
      {
        teamtailor_id: `${PREFIX}rejected-backend`,
        first_name: 'Rejected',
        last_name: 'Backend',
        email: `${PREFIX}rb@example.test`,
        pitch: 'Senior backend engineer, Go, distributed systems.',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}rejected-frontend`,
        first_name: 'Rejected',
        last_name: 'Frontend',
        email: `${PREFIX}rf@example.test`,
        pitch: 'React designer with accessibility expertise.',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}active-backend`,
        first_name: 'Active',
        last_name: 'Backend',
        email: `${PREFIX}ab@example.test`,
        pitch: 'Senior backend engineer, Go, distributed systems.',
        raw_data: {},
      },
    ])
    .select('id, teamtailor_id');
  if (cErr) throw cErr;

  const ids: Record<string, string> = {};
  for (const c of cands ?? []) ids[c.teamtailor_id as string] = c.id as string;

  // Two rejected, one active — all on the same job.
  const { error: aErr } = await db.from('applications').insert([
    {
      teamtailor_id: `${PREFIX}app-rb`,
      candidate_id: ids[`${PREFIX}rejected-backend`]!,
      job_id: jobId,
      status: 'rejected',
      rejected_at: '2024-06-01T10:00:00Z',
    },
    {
      teamtailor_id: `${PREFIX}app-rf`,
      candidate_id: ids[`${PREFIX}rejected-frontend`]!,
      job_id: jobId,
      status: 'rejected',
      rejected_at: '2024-06-15T10:00:00Z',
    },
    {
      teamtailor_id: `${PREFIX}app-ab`,
      candidate_id: ids[`${PREFIX}active-backend`]!,
      job_id: jobId,
      status: 'active',
    },
  ]);
  if (aErr) throw aErr;

  const provider = createStubProvider({ model: 'stub-hybrid', dim: 1536 });
  await runProfileEmbeddings(db, provider, { candidateIds: Object.values(ids) });
  await runNotesEmbeddings(db, provider, { candidateIds: Object.values(ids) });

  return ids;
}

describe('hybridSearchCandidates (F3-003)', () => {
  afterAll(cleanup);

  let ids: Record<string, string>;

  beforeEach(async () => {
    ids = await seed();
  });

  it('hybrid mode: query + filter restricts semantic rerank to matching candidates', async () => {
    const provider = createStubProvider({ model: 'stub-hybrid', dim: 1536 });
    const result = await hybridSearchCandidates(db, provider, {
      query: 'senior backend engineer',
      filters: {
        status: 'rejected',
        rejectedAfter: null,
        rejectedBefore: null,
        jobId: null,
      },
      limit: 10,
    });

    expect(result.mode).toBe('hybrid');
    const matchIds = result.matches.map((m) => m.candidateId);
    expect(matchIds).toContain(ids[`${PREFIX}rejected-backend`]);
    expect(matchIds).toContain(ids[`${PREFIX}rejected-frontend`]);
    // Active candidate must NOT appear — this is the core UC-01 guarantee.
    expect(matchIds).not.toContain(ids[`${PREFIX}active-backend`]);
  });

  it('empty mode: filter matches zero candidates → short-circuits', async () => {
    const provider = createStubProvider({ model: 'stub-hybrid', dim: 1536 });
    const result = await hybridSearchCandidates(db, provider, {
      query: 'anything',
      filters: {
        status: 'hired', // nobody is hired in the fixture
        rejectedAfter: null,
        rejectedBefore: null,
        jobId: null,
      },
    });

    expect(result.mode).toBe('empty');
    expect(result.matches).toEqual([]);
    expect(result.candidateIds).toEqual([]);
  });

  it('structured mode: no query → returns filtered ids without ranking', async () => {
    const provider = createStubProvider({ model: 'stub-hybrid', dim: 1536 });
    const result = await hybridSearchCandidates(db, provider, {
      query: null,
      filters: {
        status: 'rejected',
        rejectedAfter: null,
        rejectedBefore: null,
        jobId: null,
      },
    });

    expect(result.mode).toBe('structured');
    expect(result.matches).toEqual([]);
    expect(result.candidateIds).toContain(ids[`${PREFIX}rejected-backend`]);
    expect(result.candidateIds).toContain(ids[`${PREFIX}rejected-frontend`]);
    expect(result.candidateIds).not.toContain(ids[`${PREFIX}active-backend`]);
  });

  it('respects rejectedAfter date filter', async () => {
    const provider = createStubProvider({ model: 'stub-hybrid', dim: 1536 });
    const result = await hybridSearchCandidates(db, provider, {
      query: null,
      filters: {
        status: 'rejected',
        rejectedAfter: '2024-06-10T00:00:00Z',
        rejectedBefore: null,
        jobId: null,
      },
    });

    expect(result.mode).toBe('structured');
    // Only the June 15 rejection passes the after=June 10 cutoff.
    expect(result.candidateIds).toContain(ids[`${PREFIX}rejected-frontend`]);
    expect(result.candidateIds).not.toContain(ids[`${PREFIX}rejected-backend`]);
  });
});
