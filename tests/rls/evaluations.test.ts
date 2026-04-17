/**
 * RLS tests for `evaluations`.
 * Matrix: recruiter R, admin R/W.
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

describe('rls: evaluations', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('evaluations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('evaluations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-ev-anon');
    await svc.from('evaluations').insert({ candidate_id: cid, decision: 'pending' });
    const { data } = await anonClient().from('evaluations').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ev-r');
    await svc.from('evaluations').insert({ candidate_id: cid, decision: 'accept', score: 8.5 });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('evaluations').select('decision').eq('candidate_id', cid);
    expect((data ?? []).length).toBe(1);

    const { error } = await client
      .from('evaluations')
      .insert({ candidate_id: cid, decision: 'reject' });
    expect(error).not.toBeNull();
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ev-a');
    const { client } = await makeRoleClient('admin');
    const { error } = await client
      .from('evaluations')
      .insert({ candidate_id: cid, decision: 'accept' });
    expect(error).toBeNull();
  });
});
