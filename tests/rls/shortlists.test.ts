/**
 * RLS tests for `shortlists` + `shortlist_candidates`.
 * Matrix: recruiter R/W, admin R/W.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

async function seedCandidate(svc: ReturnType<typeof serviceClient>, ttId: string): Promise<string> {
  const { data, error } = await svc
    .from('candidates')
    .insert({ teamtailor_id: ttId, first_name: 'C' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed candidate failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

describe('rls: shortlists', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc
      .from('shortlist_candidates')
      .delete()
      .neq('shortlist_id', '00000000-0000-0000-0000-000000000000');
    await svc.from('shortlists').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc
      .from('shortlist_candidates')
      .delete()
      .neq('shortlist_id', '00000000-0000-0000-0000-000000000000');
    await svc.from('shortlists').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select on shortlists', async () => {
    const { data } = await anonClient().from('shortlists').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter can create a shortlist and add a candidate', async () => {
    const cid = await seedCandidate(svc, 'tt-sl-r');
    const { client, appUserId } = await makeRoleClient('recruiter');

    const sl = await client
      .from('shortlists')
      .insert({ name: 'My shortlist', created_by: appUserId })
      .select('id')
      .single();
    expect(sl.error).toBeNull();
    expect(sl.data?.id).toBeTruthy();

    const slc = await client.from('shortlist_candidates').insert({
      shortlist_id: sl.data!.id,
      candidate_id: cid,
      added_by: appUserId,
    });
    expect(slc.error).toBeNull();
  });

  it('admin can create a shortlist', async () => {
    const { client, appUserId } = await makeRoleClient('admin');
    const { error } = await client
      .from('shortlists')
      .insert({ name: 'Admin shortlist', created_by: appUserId });
    expect(error).toBeNull();
  });
});
