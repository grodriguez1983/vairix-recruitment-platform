/**
 * RLS tests for `jobs`.
 * Matrix: recruiter R, admin R/W.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: jobs', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('jobs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('jobs').insert({ teamtailor_id: 'tt-j1', title: 'Engineer' });
    const { data } = await anonClient().from('jobs').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    await svc.from('jobs').insert({ teamtailor_id: 'tt-jr', title: 'Senior' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('jobs').select('teamtailor_id');
    expect((data ?? []).some((r) => r.teamtailor_id === 'tt-jr')).toBe(true);

    const { error } = await client.from('jobs').insert({ teamtailor_id: 'tt-jh', title: 'Hack' });
    expect(error).not.toBeNull();
  });

  it('admin can insert and update', async () => {
    const { client } = await makeRoleClient('admin');
    const ins = await client
      .from('jobs')
      .insert({ teamtailor_id: 'tt-ja', title: 'Admin' })
      .select()
      .single();
    expect(ins.error).toBeNull();
    const upd = await client.from('jobs').update({ title: 'Updated' }).eq('teamtailor_id', 'tt-ja');
    expect(upd.error).toBeNull();
  });
});
