/**
 * RLS tests for `notes` (Teamtailor free-form comments).
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

describe('rls: notes', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('notes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('notes').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-n-anon');
    await svc.from('notes').insert({ candidate_id: cid, body: 'anon note' });
    const { data } = await anonClient().from('notes').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter can read and insert', async () => {
    const cid = await seedCandidate(svc, 'tt-n-r');
    const { client } = await makeRoleClient('recruiter');
    const ins = await client.from('notes').insert({ candidate_id: cid, body: 'recruiter note' });
    expect(ins.error).toBeNull();

    const { data } = await client.from('notes').select('body').eq('candidate_id', cid);
    expect((data ?? []).length).toBe(1);
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-n-a');
    const { client } = await makeRoleClient('admin');
    const { error } = await client.from('notes').insert({ candidate_id: cid, body: 'admin note' });
    expect(error).toBeNull();
  });
});
