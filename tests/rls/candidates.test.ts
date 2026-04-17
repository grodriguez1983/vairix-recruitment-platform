/**
 * RLS tests for `candidates`.
 *
 * Matrix (docs/data-model.md §16):
 *   recruiter: R/W (no soft-deleted)
 *   admin:     R/W total (includes soft-deleted)
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: candidates', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('candidates').insert({ teamtailor_id: 'tt-anon-1', first_name: 'A' });
    const anon = anonClient();
    const { data } = await anon.from('candidates').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter sees non-deleted, not soft-deleted', async () => {
    await svc.from('candidates').insert([
      { teamtailor_id: 'tt-visible', first_name: 'Visible' },
      { teamtailor_id: 'tt-deleted', first_name: 'Deleted', deleted_at: new Date().toISOString() },
    ]);
    const { client } = await makeRoleClient('recruiter');
    const { data, error } = await client.from('candidates').select('teamtailor_id');
    expect(error).toBeNull();
    const ids = (data ?? []).map((r) => r.teamtailor_id);
    expect(ids).toContain('tt-visible');
    expect(ids).not.toContain('tt-deleted');
  });

  it('admin sees soft-deleted too', async () => {
    await svc
      .from('candidates')
      .insert([
        { teamtailor_id: 'tt-del-admin', first_name: 'X', deleted_at: new Date().toISOString() },
      ]);
    const { client } = await makeRoleClient('admin');
    const { data } = await client
      .from('candidates')
      .select('teamtailor_id')
      .eq('teamtailor_id', 'tt-del-admin');
    expect((data ?? []).length).toBe(1);
  });

  it('recruiter can insert', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { error } = await client
      .from('candidates')
      .insert({ teamtailor_id: 'tt-new-rec', first_name: 'Rec' });
    expect(error).toBeNull();
  });
});
