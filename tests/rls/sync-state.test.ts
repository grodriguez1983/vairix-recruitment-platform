/**
 * RLS tests for `sync_state`.
 * Matrix: admin only. recruiter has zero visibility.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: sync_state', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const { data } = await anonClient().from('sync_state').select('entity');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter cannot see any row (even seeded entities)', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { data } = await client.from('sync_state').select('entity');
    expect((data ?? []).length).toBe(0);
  });

  it('admin reads seeded rows', async () => {
    const { client } = await makeRoleClient('admin');
    const { data } = await client.from('sync_state').select('entity');
    const entities = (data ?? []).map((r) => r.entity);
    expect(entities).toContain('candidates');
    expect(entities).toContain('applications');
  });
});
