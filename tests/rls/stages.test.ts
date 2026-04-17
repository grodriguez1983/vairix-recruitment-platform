/**
 * RLS tests for `stages`.
 * Matrix: recruiter R, admin R/W.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: stages', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('stages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('stages').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('stages').insert({ teamtailor_id: 'tt-st-anon', name: 'Applied' });
    const { data } = await anonClient().from('stages').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    await svc.from('stages').insert({ teamtailor_id: 'tt-st-r', name: 'Screening' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('stages').select('teamtailor_id');
    expect((data ?? []).some((r) => r.teamtailor_id === 'tt-st-r')).toBe(true);

    const { error } = await client
      .from('stages')
      .insert({ teamtailor_id: 'tt-st-hack', name: 'Hack' });
    expect(error).not.toBeNull();
  });

  it('admin can insert and update', async () => {
    const { client } = await makeRoleClient('admin');
    const ins = await client.from('stages').insert({ teamtailor_id: 'tt-st-a', name: 'Offer' });
    expect(ins.error).toBeNull();

    const upd = await client
      .from('stages')
      .update({ name: 'Offer v2' })
      .eq('teamtailor_id', 'tt-st-a');
    expect(upd.error).toBeNull();
  });
});
