/**
 * RLS tests for `candidate_experiences` (ADR-012).
 * Matrix (docs/data-model.md §17): recruiter R, admin R/W.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

async function seedChain(
  svc: ReturnType<typeof serviceClient>,
  ttId: string,
  hash: string,
): Promise<{ candidateId: string; fileId: string; extractionId: string }> {
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
  return { candidateId: cand!.id, fileId: file!.id, extractionId: ex!.id };
}

describe('rls: candidate_experiences', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
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
  });

  afterEach(async () => {
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
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-anon', 'h-exp-anon');
    await svc.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Acme',
    });
    const { data } = await anonClient().from('candidate_experiences').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-r', 'h-exp-r');
    await svc.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Acme',
    });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('candidate_experiences').select('company');
    expect((data ?? []).some((r) => r.company === 'Acme')).toBe(true);

    const { error } = await client.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Hack',
    });
    expect(error).not.toBeNull();
  });

  it('admin can insert, update and delete', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-a', 'h-exp-a');
    const { client } = await makeRoleClient('admin');

    const { data: inserted, error: insErr } = await client
      .from('candidate_experiences')
      .insert({
        candidate_id: candidateId,
        extraction_id: extractionId,
        source_variant: 'cv_primary',
        kind: 'work',
        company: 'Acme',
      })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const rowId = inserted!.id;

    const { error: updErr } = await client
      .from('candidate_experiences')
      .update({ title: 'Engineer' })
      .eq('id', rowId);
    expect(updErr).toBeNull();

    const { error: delErr } = await client.from('candidate_experiences').delete().eq('id', rowId);
    expect(delErr).toBeNull();
  });

  it('rejects invalid kind', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-k', 'h-exp-k');
    const { error } = await svc.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'cv_primary',
      kind: 'hobby' as 'work', // invalid
      company: 'X',
    });
    expect(error).not.toBeNull();
  });

  it('rejects invalid source_variant', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-v', 'h-exp-v');
    const { error } = await svc.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'other' as 'cv_primary', // invalid
      kind: 'work',
    });
    expect(error).not.toBeNull();
  });

  it('allows ongoing experience (end_date null)', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-ongoing', 'h-exp-ongoing');
    const { error } = await svc.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Current',
      start_date: '2023-01-01',
      end_date: null,
    });
    expect(error).toBeNull();
  });

  it('cascades on extraction delete', async () => {
    const { candidateId, extractionId } = await seedChain(svc, 'tt-exp-cc', 'h-exp-cc');
    await svc.from('candidate_experiences').insert({
      candidate_id: candidateId,
      extraction_id: extractionId,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Ephemeral',
    });
    await svc.from('candidate_extractions').delete().eq('id', extractionId);
    const { data } = await svc
      .from('candidate_experiences')
      .select('id')
      .eq('candidate_id', candidateId);
    expect((data ?? []).length).toBe(0);
  });
});
