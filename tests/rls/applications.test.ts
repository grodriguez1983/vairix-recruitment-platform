/**
 * RLS tests for `applications`.
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

describe('rls: applications', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('applications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('applications').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-app-anon');
    await svc
      .from('applications')
      .insert({ teamtailor_id: 'tt-a-anon', candidate_id: cid, status: 'active' });
    const { data } = await anonClient().from('applications').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter can read and insert', async () => {
    const cid = await seedCandidate(svc, 'tt-app-r');
    const { client } = await makeRoleClient('recruiter');
    const ins = await client
      .from('applications')
      .insert({ teamtailor_id: 'tt-a-r', candidate_id: cid, status: 'active' });
    expect(ins.error).toBeNull();

    const { data } = await client.from('applications').select('teamtailor_id');
    expect((data ?? []).some((r) => r.teamtailor_id === 'tt-a-r')).toBe(true);
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-app-a');
    const { client } = await makeRoleClient('admin');
    const { error } = await client
      .from('applications')
      .insert({ teamtailor_id: 'tt-a-a', candidate_id: cid, status: 'active' });
    expect(error).toBeNull();
  });
});
