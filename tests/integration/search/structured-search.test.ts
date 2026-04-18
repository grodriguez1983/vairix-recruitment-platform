/**
 * Integration tests for structured candidate search (F1-010a / UC-01).
 *
 * Runs against a local Supabase stack. Seeds candidates + applications
 * via the service role, then queries through a recruiter-scoped client
 * so RLS is exercised the same way a real request would.
 *
 * Acceptance criteria from docs/use-cases.md §UC-01:
 *   - `test_search_empty_query_returns_empty` — empty input returns nothing.
 *   - `test_search_respects_rls` — soft-deleted candidates hidden.
 * Plus our own:
 *   - filters by application status / job / rejected-at range
 *   - paginates with accurate total
 *   - q matches name, email, pitch (ILIKE, case-insensitive)
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { searchCandidates } from '@/lib/search/search';
import type { SearchFilters } from '@/lib/search/types';

import { makeRoleClient, resetRlsState, serviceClient } from '../../rls/helpers';

const EMPTY_FILTERS: SearchFilters = {
  q: null,
  status: null,
  rejectedAfter: null,
  rejectedBefore: null,
  jobId: null,
  hasVairixCvSheet: null,
  page: 1,
  pageSize: 20,
};

describe('structured search', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('applications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('applications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('test_search_empty_query_returns_empty: no filters → zero results', async () => {
    await svc.from('candidates').insert({ teamtailor_id: 'tt-1', first_name: 'Ada' });
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, EMPTY_FILTERS);

    expect(page.total).toBe(0);
    expect(page.results).toEqual([]);
  });

  it('matches candidates by first name (case-insensitive)', async () => {
    await svc.from('candidates').insert([
      { teamtailor_id: 'tt-a', first_name: 'Alice', last_name: 'Lang' },
      { teamtailor_id: 'tt-b', first_name: 'Bob', last_name: 'Smith' },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, q: 'alice' });

    expect(page.total).toBe(1);
    expect(page.results.map((r) => r.firstName)).toEqual(['Alice']);
  });

  it('matches by email substring', async () => {
    await svc.from('candidates').insert([
      { teamtailor_id: 'tt-c', first_name: 'C', email: 'carla@example.com' },
      { teamtailor_id: 'tt-d', first_name: 'D', email: 'dan@other.io' },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, q: 'example.com' });

    expect(page.results.map((r) => r.email)).toEqual(['carla@example.com']);
  });

  it('matches by pitch substring', async () => {
    await svc.from('candidates').insert([
      {
        teamtailor_id: 'tt-e',
        first_name: 'E',
        pitch: 'Senior backend engineer with Go experience',
      },
      { teamtailor_id: 'tt-f', first_name: 'F', pitch: 'Designer focused on mobile' },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, q: 'backend' });

    expect(page.total).toBe(1);
    expect(page.results[0]?.firstName).toBe('E');
  });

  it('test_search_respects_rls: recruiter never sees soft-deleted candidates', async () => {
    await svc.from('candidates').insert([
      { teamtailor_id: 'tt-live', first_name: 'Live' },
      {
        teamtailor_id: 'tt-gone',
        first_name: 'Live',
        deleted_at: new Date().toISOString(),
      },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, q: 'live' });

    expect(page.total).toBe(1);
    expect(page.results.map((r) => r.firstName)).toEqual(['Live']);
  });

  it('filters by application status', async () => {
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'tt-rej', first_name: 'Rej' },
        { teamtailor_id: 'tt-act', first_name: 'Act' },
      ])
      .select('id, teamtailor_id');
    const rejCand = cands?.find((c) => c.teamtailor_id === 'tt-rej')?.id;
    const actCand = cands?.find((c) => c.teamtailor_id === 'tt-act')?.id;
    await svc.from('applications').insert([
      {
        teamtailor_id: 'app-1',
        candidate_id: rejCand,
        status: 'rejected',
        rejected_at: '2025-06-01T00:00:00Z',
      },
      { teamtailor_id: 'app-2', candidate_id: actCand, status: 'active' },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, status: 'rejected' });

    expect(page.total).toBe(1);
    expect(page.results[0]?.firstName).toBe('Rej');
  });

  it('filters by rejected-at date range (gte + lt)', async () => {
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'tt-old', first_name: 'Old' },
        { teamtailor_id: 'tt-new', first_name: 'New' },
      ])
      .select('id, teamtailor_id');
    const oldCand = cands?.find((c) => c.teamtailor_id === 'tt-old')?.id;
    const newCand = cands?.find((c) => c.teamtailor_id === 'tt-new')?.id;
    await svc.from('applications').insert([
      {
        teamtailor_id: 'app-old',
        candidate_id: oldCand,
        status: 'rejected',
        rejected_at: '2024-01-15T00:00:00Z',
      },
      {
        teamtailor_id: 'app-new',
        candidate_id: newCand,
        status: 'rejected',
        rejected_at: '2025-07-15T00:00:00Z',
      },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, {
      ...EMPTY_FILTERS,
      rejectedAfter: '2025-01-01T00:00:00Z',
      rejectedBefore: '2026-01-01T00:00:00Z',
    });

    expect(page.total).toBe(1);
    expect(page.results[0]?.firstName).toBe('New');
  });

  it('filters by job_id', async () => {
    const { data: jobs } = await svc
      .from('jobs')
      .insert([
        { teamtailor_id: 'job-A', title: 'Backend' },
        { teamtailor_id: 'job-B', title: 'Frontend' },
      ])
      .select('id, teamtailor_id');
    const jobA = jobs?.find((j) => j.teamtailor_id === 'job-A')?.id;
    const jobB = jobs?.find((j) => j.teamtailor_id === 'job-B')?.id;
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'tt-A', first_name: 'AppliedA' },
        { teamtailor_id: 'tt-B', first_name: 'AppliedB' },
      ])
      .select('id, teamtailor_id');
    await svc.from('applications').insert([
      {
        teamtailor_id: 'app-A',
        candidate_id: cands?.find((c) => c.teamtailor_id === 'tt-A')?.id,
        job_id: jobA,
        status: 'active',
      },
      {
        teamtailor_id: 'app-B',
        candidate_id: cands?.find((c) => c.teamtailor_id === 'tt-B')?.id,
        job_id: jobB,
        status: 'active',
      },
    ]);
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, jobId: jobA ?? null });

    expect(page.total).toBe(1);
    expect(page.results[0]?.firstName).toBe('AppliedA');
  });

  it('paginates with correct total', async () => {
    const rows = Array.from({ length: 5 }, (_, i) => ({
      teamtailor_id: `tt-page-${i}`,
      first_name: `PageUser${i}`,
    }));
    await svc.from('candidates').insert(rows);
    const { client } = await makeRoleClient('recruiter');

    const first = await searchCandidates(client, {
      ...EMPTY_FILTERS,
      q: 'pageuser',
      page: 1,
      pageSize: 2,
    });
    const second = await searchCandidates(client, {
      ...EMPTY_FILTERS,
      q: 'pageuser',
      page: 2,
      pageSize: 2,
    });
    const third = await searchCandidates(client, {
      ...EMPTY_FILTERS,
      q: 'pageuser',
      page: 3,
      pageSize: 2,
    });

    expect(first.total).toBe(5);
    expect(first.results).toHaveLength(2);
    expect(second.results).toHaveLength(2);
    expect(third.results).toHaveLength(1);
    const allIds = [...first.results, ...second.results, ...third.results].map((r) => r.id);
    expect(new Set(allIds).size).toBe(5);
  });

  it('hasVairixCvSheet=true: returns candidates whose interviews carry the TT "Información para CV" answer (q=24016)', async () => {
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'tt-with-sheet', first_name: 'WithSheet' },
        { teamtailor_id: 'tt-without-sheet', first_name: 'WithoutSheet' },
        { teamtailor_id: 'tt-blank-sheet', first_name: 'BlankSheet' },
      ])
      .select('id, teamtailor_id');
    const withSheet = cands?.find((c) => c.teamtailor_id === 'tt-with-sheet')?.id;
    const blankSheet = cands?.find((c) => c.teamtailor_id === 'tt-blank-sheet')?.id;

    // Seed evaluations + evaluation_answers. Candidate `withSheet` has
    // the URL; `blankSheet` has the q=24016 row but value_text is null
    // (interview existed, field was left empty) → should NOT match.
    const { data: evals } = await svc
      .from('evaluations')
      .insert([
        { teamtailor_id: 'ev-with', candidate_id: withSheet },
        { teamtailor_id: 'ev-blank', candidate_id: blankSheet },
      ])
      .select('id, teamtailor_id');
    const evWith = evals?.find((e) => e.teamtailor_id === 'ev-with')?.id;
    const evBlank = evals?.find((e) => e.teamtailor_id === 'ev-blank')?.id;

    await svc.from('evaluation_answers').insert([
      {
        evaluation_id: evWith,
        teamtailor_answer_id: 'ans-with-sheet',
        question_tt_id: '24016',
        question_type: 'text',
        value_text: 'https://docs.google.com/spreadsheets/d/xyz/edit',
      },
      {
        evaluation_id: evBlank,
        teamtailor_answer_id: 'ans-blank-sheet',
        question_tt_id: '24016',
        question_type: 'text',
        value_text: null,
      },
    ]);

    const { client } = await makeRoleClient('recruiter');
    const page = await searchCandidates(client, { ...EMPTY_FILTERS, hasVairixCvSheet: true });

    expect(page.total).toBe(1);
    expect(page.results.map((r) => r.firstName)).toEqual(['WithSheet']);
  });

  it('hasVairixCvSheet=true: falls back to files.kind=vairix_cv_sheet when the TT URL is absent', async () => {
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'tt-uploaded', first_name: 'Uploaded' },
        { teamtailor_id: 'tt-nothing', first_name: 'Nothing' },
      ])
      .select('id, teamtailor_id');
    const uploaded = cands?.find((c) => c.teamtailor_id === 'tt-uploaded')?.id;

    await svc.from('files').insert({
      candidate_id: uploaded,
      storage_path: `${uploaded}/vairix-sheet.xlsx`,
      kind: 'vairix_cv_sheet',
      file_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    });

    const { client } = await makeRoleClient('recruiter');
    const page = await searchCandidates(client, { ...EMPTY_FILTERS, hasVairixCvSheet: true });

    expect(page.total).toBe(1);
    expect(page.results.map((r) => r.firstName)).toEqual(['Uploaded']);
  });

  it('hasVairixCvSheet=false is ignored (treated as "no filter")', async () => {
    await svc.from('candidates').insert([
      { teamtailor_id: 'tt-x', first_name: 'Xavier' },
      { teamtailor_id: 'tt-y', first_name: 'Yvette' },
    ]);
    const { client } = await makeRoleClient('recruiter');

    // Without any other filter, should still return empty (same
    // invariant as plain `EMPTY_FILTERS`).
    const page = await searchCandidates(client, { ...EMPTY_FILTERS, hasVairixCvSheet: false });

    expect(page.total).toBe(0);
  });

  it('returns empty when application filter matches nothing (short-circuit)', async () => {
    await svc.from('candidates').insert({ teamtailor_id: 'tt-lonely', first_name: 'Lonely' });
    const { client } = await makeRoleClient('recruiter');

    const page = await searchCandidates(client, { ...EMPTY_FILTERS, status: 'hired' });

    expect(page.total).toBe(0);
    expect(page.results).toEqual([]);
  });
});
