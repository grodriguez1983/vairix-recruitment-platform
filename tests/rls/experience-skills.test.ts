/**
 * RLS tests for `experience_skills` (ADR-012 + ADR-013).
 *
 * Matrix (docs/data-model.md §17): recruiter R, admin R/W.
 * Invariant: `skill_id` may be NULL (uncataloged skill — the row still
 * exists so the admin report can surface it). `skill_id` gets set to
 * NULL on skill delete (NOT cascade — we preserve historical mentions).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

async function seedChain(
  svc: ReturnType<typeof serviceClient>,
  ttId: string,
  hash: string,
): Promise<{ candidateId: string; experienceId: string }> {
  const { data: cand } = await svc
    .from('candidates')
    .insert({ teamtailor_id: ttId, first_name: 'C' })
    .select('id')
    .single();
  const { data: file } = await svc
    .from('files')
    .insert({ candidate_id: cand!.id, storage_path: `cv/${ttId}.pdf` })
    .select('id')
    .single();
  const { data: ex } = await svc
    .from('candidate_extractions')
    .insert({
      candidate_id: cand!.id,
      file_id: file!.id,
      source_variant: 'cv_primary',
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: hash,
      raw_output: {},
    })
    .select('id')
    .single();
  const { data: exp } = await svc
    .from('candidate_experiences')
    .insert({
      candidate_id: cand!.id,
      extraction_id: ex!.id,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Acme',
    })
    .select('id')
    .single();
  return { candidateId: cand!.id, experienceId: exp!.id };
}

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

describe('rls: experience_skills', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('experience_skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc
      .from('candidate_experiences')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc
      .from('candidate_extractions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('experience_skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc
      .from('candidate_experiences')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc
      .from('candidate_extractions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const { experienceId } = await seedChain(svc, 'tt-es-anon', 'h-es-anon');
    await svc.from('experience_skills').insert({ experience_id: experienceId, skill_raw: 'react' });
    const { data } = await anonClient().from('experience_skills').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const { experienceId } = await seedChain(svc, 'tt-es-r', 'h-es-r');
    await svc.from('experience_skills').insert({ experience_id: experienceId, skill_raw: 'react' });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('experience_skills').select('skill_raw');
    expect((data ?? []).some((r) => r.skill_raw === 'react')).toBe(true);

    const { error } = await client
      .from('experience_skills')
      .insert({ experience_id: experienceId, skill_raw: 'hack' });
    expect(error).not.toBeNull();
  });

  it('admin can insert and delete', async () => {
    const { experienceId } = await seedChain(svc, 'tt-es-a', 'h-es-a');
    const { client } = await makeRoleClient('admin');

    const { data: ins, error: insErr } = await client
      .from('experience_skills')
      .insert({ experience_id: experienceId, skill_raw: 'postgresql' })
      .select('id')
      .single();
    expect(insErr).toBeNull();

    const { error: delErr } = await client.from('experience_skills').delete().eq('id', ins!.id);
    expect(delErr).toBeNull();
  });

  it('allows skill_id NULL (uncataloged)', async () => {
    const { experienceId } = await seedChain(svc, 'tt-es-null', 'h-es-null');
    const { error } = await svc.from('experience_skills').insert({
      experience_id: experienceId,
      skill_raw: 'some obscure tech',
      skill_id: null,
    });
    expect(error).toBeNull();
  });

  it('sets skill_id to NULL when the skill is deleted (no cascade of row)', async () => {
    const { experienceId } = await seedChain(svc, 'tt-es-sd', 'h-es-sd');
    const skillId = await seedSkill(svc, 'React', 'react');
    const { data: ins } = await svc
      .from('experience_skills')
      .insert({ experience_id: experienceId, skill_raw: 'react', skill_id: skillId })
      .select('id')
      .single();
    await svc.from('skills').delete().eq('id', skillId);
    const { data: after } = await svc
      .from('experience_skills')
      .select('skill_id, skill_raw')
      .eq('id', ins!.id)
      .single();
    expect(after?.skill_id).toBeNull();
    expect(after?.skill_raw).toBe('react'); // preserved for uncataloged report
  });

  it('cascades on experience delete', async () => {
    const { experienceId } = await seedChain(svc, 'tt-es-cc', 'h-es-cc');
    await svc
      .from('experience_skills')
      .insert({ experience_id: experienceId, skill_raw: 'ephemeral' });
    await svc.from('candidate_experiences').delete().eq('id', experienceId);
    const { data } = await svc
      .from('experience_skills')
      .select('id')
      .eq('experience_id', experienceId);
    expect((data ?? []).length).toBe(0);
  });
});
