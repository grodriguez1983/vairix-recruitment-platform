/**
 * RLS tests for `users` (Teamtailor evaluators, NOT app_users).
 *
 * Matrix: recruiter R, admin R/W.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: users (teamtailor evaluators)', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('users').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('users').insert({ teamtailor_id: 'tt-user-1', email: 'e@x.test' });
    const { data } = await anonClient().from('users').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter can read but not write', async () => {
    await svc.from('users').insert({ teamtailor_id: 'tt-u-ro', email: 'ro@x.test' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('users').select('teamtailor_id');
    expect((data ?? []).some((r) => r.teamtailor_id === 'tt-u-ro')).toBe(true);

    const { error } = await client
      .from('users')
      .insert({ teamtailor_id: 'tt-u-hack', email: 'h@x.test' });
    expect(error).not.toBeNull();
  });

  it('admin can write', async () => {
    const { client } = await makeRoleClient('admin');
    const { error } = await client
      .from('users')
      .insert({ teamtailor_id: 'tt-u-adm', email: 'a@x.test' });
    expect(error).toBeNull();
  });
});
