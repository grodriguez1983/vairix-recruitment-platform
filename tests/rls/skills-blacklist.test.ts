/**
 * RLS tests for `skills_blacklist`.
 * Matrix (ADR-013 §6): SELECT+INSERT+DELETE admin only. Recruiter
 * cannot see this table. Used by the admin UI uncataloged report to
 * hide entries already reviewed-and-discarded; the resolver does NOT
 * consult it.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: skills_blacklist', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('skills_blacklist').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('skills_blacklist').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('skills_blacklist').insert({ alias_normalized: 'team player' });
    const { data } = await anonClient().from('skills_blacklist').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter cannot select', async () => {
    await svc.from('skills_blacklist').insert({ alias_normalized: 'hands on' });
    const { client } = await makeRoleClient('recruiter');
    const { data } = await client.from('skills_blacklist').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter cannot insert', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { error } = await client
      .from('skills_blacklist')
      .insert({ alias_normalized: 'dynamic personality' });
    expect(error).not.toBeNull();
  });

  it('admin can insert, select and delete', async () => {
    const { client } = await makeRoleClient('admin');

    const { data: inserted, error: insErr } = await client
      .from('skills_blacklist')
      .insert({ alias_normalized: 'motivated self starter', reason: 'noise from CVs' })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const rowId = inserted!.id;

    const { data: readBack } = await client
      .from('skills_blacklist')
      .select('alias_normalized')
      .eq('id', rowId)
      .single();
    expect(readBack?.alias_normalized).toBe('motivated self starter');

    const { error: delErr } = await client.from('skills_blacklist').delete().eq('id', rowId);
    expect(delErr).toBeNull();
  });

  it('alias_normalized is unique', async () => {
    await svc.from('skills_blacklist').insert({ alias_normalized: 'go-getter' });
    const { error } = await svc.from('skills_blacklist').insert({ alias_normalized: 'go-getter' });
    expect(error).not.toBeNull();
  });
});
