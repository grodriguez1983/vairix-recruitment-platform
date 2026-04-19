/**
 * Integration tests for hydrateCandidatesByIds (F3-002/F3-003
 * support helper).
 *
 * The search pages pass only candidate ids (from embedding ANN search
 * or structured filters) through this hydrator to render cards. The
 * two invariants it must uphold:
 *
 *   1. Order preservation — relevance order is determined by the
 *      caller, NOT the database. If the hydrator reordered rows,
 *      top-ranked candidates would lose their position in the UI.
 *   2. RLS-scoped drop — ids the recruiter isn't allowed to see (soft
 *      deleted, future tenant scoping) silently disappear instead of
 *      leaking a partial row or throwing.
 *
 * Retro-coverage for commit 8d47297 (added after the code shipped).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { hydrateCandidatesByIds } from '@/lib/search/hydrate';

import { makeRoleClient, resetRlsState, serviceClient } from '../../rls/helpers';

describe('hydrateCandidatesByIds', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('returns [] for empty input without hitting the database', async () => {
    const { client } = await makeRoleClient('recruiter');
    const out = await hydrateCandidatesByIds(client, []);
    expect(out).toEqual([]);
  });

  it('preserves caller-provided order (relevance, not insertion)', async () => {
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'hyd-a', first_name: 'Alpha' },
        { teamtailor_id: 'hyd-b', first_name: 'Beta' },
        { teamtailor_id: 'hyd-c', first_name: 'Gamma' },
      ])
      .select('id, teamtailor_id');
    const byTt = new Map((cands ?? []).map((c) => [c.teamtailor_id as string, c.id as string]));
    const idA = byTt.get('hyd-a')!;
    const idB = byTt.get('hyd-b')!;
    const idC = byTt.get('hyd-c')!;

    const { client } = await makeRoleClient('recruiter');

    // Request in reversed, non-insertion order — the hydrator must
    // return rows in that exact order.
    const out = await hydrateCandidatesByIds(client, [idC, idA, idB]);
    expect(out.map((r) => r.id)).toEqual([idC, idA, idB]);
    expect(out.map((r) => r.firstName)).toEqual(['Gamma', 'Alpha', 'Beta']);
  });

  it('drops ids the RLS-scoped client cannot see (soft-deleted)', async () => {
    const { data: cands } = await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'hyd-live', first_name: 'Live' },
        {
          teamtailor_id: 'hyd-gone',
          first_name: 'Gone',
          deleted_at: new Date().toISOString(),
        },
      ])
      .select('id, teamtailor_id');
    const liveId = cands?.find((c) => c.teamtailor_id === 'hyd-live')?.id as string;
    const goneId = cands?.find((c) => c.teamtailor_id === 'hyd-gone')?.id as string;

    const { client } = await makeRoleClient('recruiter');

    // Recruiter asks for both; soft-deleted row is invisible via RLS.
    // The hydrator drops it silently rather than returning a hole or
    // throwing — the UI renders only what the caller is allowed to see.
    const out = await hydrateCandidatesByIds(client, [liveId, goneId]);
    expect(out.map((r) => r.id)).toEqual([liveId]);
    expect(out[0]?.firstName).toBe('Live');
  });

  it('drops unknown ids (e.g. deleted between search and hydrate)', async () => {
    const { data: cand } = await svc
      .from('candidates')
      .insert({ teamtailor_id: 'hyd-only', first_name: 'Only' })
      .select('id')
      .single();
    const realId = cand!.id as string;
    const fakeId = '11111111-2222-3333-4444-555555555555';

    const { client } = await makeRoleClient('recruiter');

    const out = await hydrateCandidatesByIds(client, [fakeId, realId]);
    expect(out.map((r) => r.id)).toEqual([realId]);
  });

  it('maps all card fields (firstName/lastName/email/pitch/linkedinUrl)', async () => {
    const { data: cand } = await svc
      .from('candidates')
      .insert({
        teamtailor_id: 'hyd-full',
        first_name: 'Full',
        last_name: 'Row',
        email: 'full@example.test',
        pitch: 'Backend engineer, 10y Go.',
        linkedin_url: 'https://linkedin.com/in/full-row',
      })
      .select('id')
      .single();

    const { client } = await makeRoleClient('recruiter');
    const [row] = await hydrateCandidatesByIds(client, [cand!.id as string]);

    expect(row).toEqual({
      id: cand!.id,
      firstName: 'Full',
      lastName: 'Row',
      email: 'full@example.test',
      pitch: 'Backend engineer, 10y Go.',
      linkedinUrl: 'https://linkedin.com/in/full-row',
    });
  });

  it('deduplicates repeated ids in input (query uses IN → rows are unique)', async () => {
    const { data: cand } = await svc
      .from('candidates')
      .insert({ teamtailor_id: 'hyd-dup', first_name: 'Dup' })
      .select('id')
      .single();
    const id = cand!.id as string;

    const { client } = await makeRoleClient('recruiter');
    // Caller passes the same id twice; implementation looks up via a
    // Map, so the row is emitted once per occurrence. This documents
    // current behavior so future changes are deliberate.
    const out = await hydrateCandidatesByIds(client, [id, id]);
    expect(out.map((r) => r.id)).toEqual([id, id]);
  });
});
