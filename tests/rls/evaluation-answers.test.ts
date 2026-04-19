/**
 * RLS tests for `evaluation_answers`.
 * Matrix: recruiter R, admin R/W. Mirrors `evaluations`.
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

async function seedEvaluation(
  svc: ReturnType<typeof serviceClient>,
  candidateId: string,
): Promise<string> {
  const { data, error } = await svc
    .from('evaluations')
    .insert({ candidate_id: candidateId, decision: 'pending' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed evaluation failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

describe('rls: evaluation_answers', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('evaluation_answers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('evaluations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('evaluation_answers').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('evaluations').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-ans-anon');
    const evalId = await seedEvaluation(svc, cid);
    await svc.from('evaluation_answers').insert({
      evaluation_id: evalId,
      teamtailor_answer_id: 'ans-anon-1',
      question_tt_id: '24016',
      value_text: 'https://docs/x',
    });
    const { data } = await anonClient().from('evaluation_answers').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ans-r');
    const evalId = await seedEvaluation(svc, cid);
    await svc.from('evaluation_answers').insert({
      evaluation_id: evalId,
      teamtailor_answer_id: 'ans-r-1',
      question_tt_id: '24016',
      question_title: 'Información para CV',
      value_text: 'https://docs/x',
    });
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client
      .from('evaluation_answers')
      .select('value_text')
      .eq('evaluation_id', evalId);
    expect((data ?? []).length).toBe(1);

    const { error } = await client.from('evaluation_answers').insert({
      evaluation_id: evalId,
      teamtailor_answer_id: 'ans-r-2',
      question_tt_id: '99999',
      value_text: 'denied',
    });
    expect(error).not.toBeNull();
  });

  it('recruiter cannot update or delete', async () => {
    const cid = await seedCandidate(svc, 'tt-ans-rw');
    const evalId = await seedEvaluation(svc, cid);
    const { data: inserted } = await svc
      .from('evaluation_answers')
      .insert({
        evaluation_id: evalId,
        teamtailor_answer_id: 'ans-rw-1',
        question_tt_id: '24016',
        value_text: 'original',
      })
      .select('id')
      .single();
    const rowId = inserted!.id;

    const { client } = await makeRoleClient('recruiter');

    const { error: updErr, data: updData } = await client
      .from('evaluation_answers')
      .update({ value_text: 'tampered' })
      .eq('id', rowId)
      .select('id');
    // RLS on update may surface as either an error or zero affected rows
    expect(updErr !== null || (updData?.length ?? 0) === 0).toBe(true);

    const { error: delErr, data: delData } = await client
      .from('evaluation_answers')
      .delete()
      .eq('id', rowId)
      .select('id');
    expect(delErr !== null || (delData?.length ?? 0) === 0).toBe(true);

    const { data: stillThere } = await svc
      .from('evaluation_answers')
      .select('value_text')
      .eq('id', rowId)
      .single();
    expect(stillThere?.value_text).toBe('original');
  });

  it('admin can insert, update and delete', async () => {
    const cid = await seedCandidate(svc, 'tt-ans-a');
    const evalId = await seedEvaluation(svc, cid);
    const { client } = await makeRoleClient('admin');

    const { data: inserted, error: insErr } = await client
      .from('evaluation_answers')
      .insert({
        evaluation_id: evalId,
        teamtailor_answer_id: 'ans-a-1',
        question_tt_id: '24016',
        value_text: 'https://docs/x',
      })
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const rowId = inserted!.id;

    const { error: updErr } = await client
      .from('evaluation_answers')
      .update({ value_text: 'updated' })
      .eq('id', rowId);
    expect(updErr).toBeNull();

    const { error: delErr } = await client.from('evaluation_answers').delete().eq('id', rowId);
    expect(delErr).toBeNull();
  });
});
