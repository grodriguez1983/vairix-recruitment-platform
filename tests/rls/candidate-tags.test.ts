/**
 * RLS tests for `candidate_tags`.
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

async function seedTag(svc: ReturnType<typeof serviceClient>, name: string): Promise<string> {
  const { data, error } = await svc.from('tags').insert({ name }).select('id').single();
  if (error || !data) throw new Error(`seed tag failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

describe('rls: candidate_tags', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('candidate_tags').delete().neq('tag_id', '00000000-0000-0000-0000-000000000000');
    await svc.from('tags').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('candidate_tags').delete().neq('tag_id', '00000000-0000-0000-0000-000000000000');
    await svc.from('tags').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-ct-anon');
    const tid = await seedTag(svc, 'anon-tag');
    await svc.from('candidate_tags').insert({ candidate_id: cid, tag_id: tid });
    const { data } = await anonClient().from('candidate_tags').select('tag_id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter can read and insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ct-r');
    const tid = await seedTag(svc, 'r-tag');
    const { client } = await makeRoleClient('recruiter');
    const ins = await client
      .from('candidate_tags')
      .insert({ candidate_id: cid, tag_id: tid, source: 'manual' });
    expect(ins.error).toBeNull();

    const { data } = await client.from('candidate_tags').select('tag_id').eq('candidate_id', cid);
    expect((data ?? []).length).toBe(1);
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ct-a');
    const tid = await seedTag(svc, 'a-tag');
    const { client } = await makeRoleClient('admin');
    const { error } = await client
      .from('candidate_tags')
      .insert({ candidate_id: cid, tag_id: tid });
    expect(error).toBeNull();
  });
});
