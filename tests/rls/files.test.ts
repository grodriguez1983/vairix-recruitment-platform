/**
 * RLS tests for `files` (CVs).
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

describe('rls: files', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-f-anon');
    await svc.from('files').insert({ candidate_id: cid, storage_path: 'cv/anon.pdf' });
    const { data } = await anonClient().from('files').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const cid = await seedCandidate(svc, 'tt-f-r');
    await svc.from('files').insert({ candidate_id: cid, storage_path: 'cv/r.pdf' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('files').select('storage_path');
    expect((data ?? []).some((r) => r.storage_path === 'cv/r.pdf')).toBe(true);

    const { error } = await client
      .from('files')
      .insert({ candidate_id: cid, storage_path: 'cv/hack.pdf' });
    expect(error).not.toBeNull();
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-f-a');
    const { client } = await makeRoleClient('admin');
    const { error } = await client
      .from('files')
      .insert({ candidate_id: cid, storage_path: 'cv/admin.pdf' });
    expect(error).toBeNull();
  });
});
