/**
 * RLS tests for `tags`.
 * Matrix: recruiter R/W, admin R/W.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: tags', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('tags').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('tags').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('tags').insert({ name: 'seed-tag' });
    const { data } = await anonClient().from('tags').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter can read and insert', async () => {
    const { client } = await makeRoleClient('recruiter');
    const ins = await client.from('tags').insert({ name: 'rec-tag', category: 'skill' });
    expect(ins.error).toBeNull();
    const { data } = await client.from('tags').select('name').eq('name', 'rec-tag');
    expect((data ?? []).length).toBe(1);
  });

  it('admin can insert', async () => {
    const { client } = await makeRoleClient('admin');
    const { error } = await client.from('tags').insert({ name: 'adm-tag' });
    expect(error).toBeNull();
  });
});
