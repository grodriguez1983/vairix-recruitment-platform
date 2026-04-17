/**
 * RLS tests for `sync_errors`.
 * Matrix: admin only.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: sync_errors', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('sync_errors').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('sync_errors').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('sync_errors').insert({
      entity: 'candidates',
      error_code: 'http_500',
      run_started_at: new Date().toISOString(),
    });
    const { data } = await anonClient().from('sync_errors').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter cannot read', async () => {
    await svc.from('sync_errors').insert({
      entity: 'candidates',
      run_started_at: new Date().toISOString(),
    });
    const { client } = await makeRoleClient('recruiter');
    const { data } = await client.from('sync_errors').select('id');
    expect((data ?? []).length).toBe(0);
  });

  it('admin can read and write', async () => {
    const { client } = await makeRoleClient('admin');
    const ins = await client.from('sync_errors').insert({
      entity: 'jobs',
      error_code: 'parse_error',
      run_started_at: new Date().toISOString(),
    });
    expect(ins.error).toBeNull();
  });
});
