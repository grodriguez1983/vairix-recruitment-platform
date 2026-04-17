/**
 * RLS tests for `embeddings`.
 * Matrix: recruiter R (indirecto), admin R/W.
 * Los embeddings se generan por el worker con service role; recruiter
 * nunca inserta/actualiza desde la app. Policies bloquean W para roles
 * autenticados y solo permiten R.
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

describe('rls: embeddings', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('embeddings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('embeddings').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-e-anon');
    await svc.from('embeddings').insert({
      candidate_id: cid,
      source_type: 'cv',
      content: 'hello',
      content_hash: 'hash-anon',
    });
    const { data } = await anonClient().from('embeddings').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const cid = await seedCandidate(svc, 'tt-e-r');
    await svc.from('embeddings').insert({
      candidate_id: cid,
      source_type: 'cv',
      content: 'cv text',
      content_hash: 'hash-r',
    });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('embeddings').select('content_hash');
    expect((data ?? []).some((r) => r.content_hash === 'hash-r')).toBe(true);

    const { error } = await client.from('embeddings').insert({
      candidate_id: cid,
      source_type: 'cv',
      content: 'hack',
      content_hash: 'hash-hack',
    });
    expect(error).not.toBeNull();
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-e-a');
    const { client } = await makeRoleClient('admin');
    const { error } = await client.from('embeddings').insert({
      candidate_id: cid,
      source_type: 'cv',
      content: 'admin content',
      content_hash: 'hash-a',
    });
    expect(error).toBeNull();
  });
});
