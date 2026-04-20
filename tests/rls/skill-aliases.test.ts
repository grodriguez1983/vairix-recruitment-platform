/**
 * RLS tests for `skill_aliases`.
 * Matrix (ADR-013 §6): identical to `skills`.
 * Additional invariant: alias_normalized is globally unique.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

async function seedSkill(
  svc: ReturnType<typeof serviceClient>,
  canonical: string,
  slug: string,
): Promise<string> {
  const { data, error } = await svc
    .from('skills')
    .insert({ canonical_name: canonical, slug })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed skill failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

describe('rls: skill_aliases', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('skill_aliases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('skill_aliases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const skillId = await seedSkill(svc, 'React', 'react');
    await svc
      .from('skill_aliases')
      .insert({ skill_id: skillId, alias_normalized: 'reactjs', source: 'seed' });
    const { data } = await anonClient().from('skill_aliases').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const skillId = await seedSkill(svc, 'React', 'react');
    await svc
      .from('skill_aliases')
      .insert({ skill_id: skillId, alias_normalized: 'reactjs', source: 'seed' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client
      .from('skill_aliases')
      .select('alias_normalized')
      .eq('alias_normalized', 'reactjs');
    expect((data ?? []).length).toBe(1);

    const { error } = await client
      .from('skill_aliases')
      .insert({ skill_id: skillId, alias_normalized: 'react.js', source: 'admin' });
    expect(error).not.toBeNull();
  });

  it('admin can insert, update and delete', async () => {
    const skillId = await seedSkill(svc, 'React', 'react');
    const { client } = await makeRoleClient('admin');

    const { data: inserted, error: insErr } = await client
      .from('skill_aliases')
      .insert({ skill_id: skillId, alias_normalized: 'reactjs', source: 'admin' })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const rowId = inserted!.id;

    const { error: updErr } = await client
      .from('skill_aliases')
      .update({ source: 'derived' })
      .eq('id', rowId);
    expect(updErr).toBeNull();

    const { error: delErr } = await client.from('skill_aliases').delete().eq('id', rowId);
    expect(delErr).toBeNull();
  });

  it('alias_normalized is globally unique', async () => {
    const a = await seedSkill(svc, 'React', 'react');
    const b = await seedSkill(svc, 'React Native', 'react-native');
    const { error: firstErr } = await svc
      .from('skill_aliases')
      .insert({ skill_id: a, alias_normalized: 'react', source: 'seed' });
    expect(firstErr).toBeNull();
    const { error: secondErr } = await svc
      .from('skill_aliases')
      .insert({ skill_id: b, alias_normalized: 'react', source: 'seed' });
    expect(secondErr).not.toBeNull();
  });

  it('rejects invalid source values', async () => {
    const skillId = await seedSkill(svc, 'React', 'react');
    const { error } = await svc.from('skill_aliases').insert({
      skill_id: skillId,
      alias_normalized: 'reactjs',
      source: 'manual' as 'seed', // intentionally invalid check constraint value
    });
    expect(error).not.toBeNull();
  });

  it('cascades on skill delete', async () => {
    const skillId = await seedSkill(svc, 'Ephemeral', 'ephemeral');
    await svc
      .from('skill_aliases')
      .insert({ skill_id: skillId, alias_normalized: 'ephemeral', source: 'seed' });
    await svc.from('skills').delete().eq('id', skillId);
    const { data } = await svc
      .from('skill_aliases')
      .select('id')
      .eq('alias_normalized', 'ephemeral');
    expect((data ?? []).length).toBe(0);
  });
});
