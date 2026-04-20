/**
 * RLS tests for `skills`.
 * Matrix (ADR-013 §6): SELECT open to recruiter+admin. INSERT/UPDATE/DELETE
 * admin only. Anonymous denied on everything.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

describe('rls: skills', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    await svc.from('skills').insert({ canonical_name: 'React', slug: 'react' });
    const { data } = await anonClient().from('skills').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    await svc.from('skills').insert({ canonical_name: 'React', slug: 'react' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('skills').select('slug').eq('slug', 'react');
    expect((data ?? []).length).toBe(1);

    const { error } = await client.from('skills').insert({ canonical_name: 'Vue', slug: 'vue' });
    expect(error).not.toBeNull();
  });

  it('recruiter cannot update or delete', async () => {
    const { data: inserted } = await svc
      .from('skills')
      .insert({ canonical_name: 'React', slug: 'react' })
      .select('id')
      .single();
    const rowId = inserted!.id;

    const { client } = await makeRoleClient('recruiter');

    const { error: updErr, data: updData } = await client
      .from('skills')
      .update({ canonical_name: 'Reactive' })
      .eq('id', rowId)
      .select('id');
    expect(updErr !== null || (updData?.length ?? 0) === 0).toBe(true);

    const { error: delErr, data: delData } = await client
      .from('skills')
      .delete()
      .eq('id', rowId)
      .select('id');
    expect(delErr !== null || (delData?.length ?? 0) === 0).toBe(true);

    const { data: stillThere } = await svc
      .from('skills')
      .select('canonical_name')
      .eq('id', rowId)
      .single();
    expect(stillThere?.canonical_name).toBe('React');
  });

  it('admin can insert, update and delete', async () => {
    const { client } = await makeRoleClient('admin');

    const { data: inserted, error: insErr } = await client
      .from('skills')
      .insert({ canonical_name: 'PostgreSQL', slug: 'postgresql' })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const rowId = inserted!.id;

    const { error: updErr } = await client
      .from('skills')
      .update({ category: 'database' })
      .eq('id', rowId);
    expect(updErr).toBeNull();

    const { error: delErr } = await client.from('skills').delete().eq('id', rowId);
    expect(delErr).toBeNull();
  });

  it('slug is unique globally', async () => {
    await svc.from('skills').insert({ canonical_name: 'React', slug: 'react' });
    const { error } = await svc
      .from('skills')
      .insert({ canonical_name: 'React JS', slug: 'react' });
    expect(error).not.toBeNull();
  });

  it('canonical_name is not required unique', async () => {
    // Two rows with the same canonical_name but different slugs must coexist
    // (ADR-013 §1 intentionally leaves canonical_name free).
    const { error: firstErr } = await svc
      .from('skills')
      .insert({ canonical_name: 'Node', slug: 'node' });
    expect(firstErr).toBeNull();
    const { error: secondErr } = await svc
      .from('skills')
      .insert({ canonical_name: 'Node', slug: 'nodejs-runtime' });
    expect(secondErr).toBeNull();
  });
});
