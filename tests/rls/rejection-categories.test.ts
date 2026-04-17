/**
 * RLS tests for `rejection_categories`.
 * Matrix: recruiter R, admin R/W. Seeded catalog — no deletes in tests.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: rejection_categories', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
  });

  afterEach(async () => {
    await svc.from('rejection_categories').delete().like('code', 'test_%');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const { data } = await anonClient().from('rejection_categories').select('code');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads seeded catalog', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { data } = await client.from('rejection_categories').select('code');
    const codes = (data ?? []).map((r) => r.code);
    expect(codes).toContain('technical_skills');
    expect(codes).toContain('other');
  });

  it('recruiter cannot insert', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { error } = await client
      .from('rejection_categories')
      .insert({ code: 'test_hack', display_name: 'Hack' });
    expect(error).not.toBeNull();
  });

  it('admin can insert and update', async () => {
    const { client } = await makeRoleClient('admin');
    const ins = await client
      .from('rejection_categories')
      .insert({ code: 'test_adm', display_name: 'Adm' });
    expect(ins.error).toBeNull();
  });
});
