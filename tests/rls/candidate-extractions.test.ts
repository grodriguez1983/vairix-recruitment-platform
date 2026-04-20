/**
 * RLS + immutability tests for `candidate_extractions` (ADR-012).
 *
 * Matrix (docs/data-model.md §17): recruiter R, admin R/W.
 * Invariant: `raw_output` is immutable post-insert (idempotencia by
 * `content_hash`). Enforced via a BEFORE UPDATE trigger; tested here.
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

async function seedFile(
  svc: ReturnType<typeof serviceClient>,
  candidateId: string,
  path: string,
): Promise<string> {
  const { data, error } = await svc
    .from('files')
    .insert({ candidate_id: candidateId, storage_path: path })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed file failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

async function seedExtraction(
  svc: ReturnType<typeof serviceClient>,
  candidateId: string,
  fileId: string,
  contentHash: string,
  variant: 'linkedin_export' | 'cv_primary' = 'cv_primary',
  rawOutput: Record<string, unknown> = { experiences: [] },
): Promise<string> {
  const { data, error } = await svc
    .from('candidate_extractions')
    .insert({
      candidate_id: candidateId,
      file_id: fileId,
      source_variant: variant,
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: contentHash,
      raw_output: rawOutput,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed extraction failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

describe('rls: candidate_extractions', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc
      .from('candidate_extractions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc
      .from('candidate_extractions')
      .delete()
      .neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const cid = await seedCandidate(svc, 'tt-ex-anon');
    const fid = await seedFile(svc, cid, 'cv/anon.pdf');
    await seedExtraction(svc, cid, fid, 'hash-anon');
    const { data } = await anonClient().from('candidate_extractions').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads but cannot insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ex-r');
    const fid = await seedFile(svc, cid, 'cv/r.pdf');
    await seedExtraction(svc, cid, fid, 'hash-r');
    const { client } = await makeRoleClient('recruiter');

    const { data } = await client.from('candidate_extractions').select('content_hash');
    expect((data ?? []).some((r) => r.content_hash === 'hash-r')).toBe(true);

    const { error } = await client.from('candidate_extractions').insert({
      candidate_id: cid,
      file_id: fid,
      source_variant: 'cv_primary',
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: 'hash-hack',
      raw_output: {},
    });
    expect(error).not.toBeNull();
  });

  it('admin can insert', async () => {
    const cid = await seedCandidate(svc, 'tt-ex-a');
    const fid = await seedFile(svc, cid, 'cv/a.pdf');
    const { client } = await makeRoleClient('admin');

    const { error } = await client.from('candidate_extractions').insert({
      candidate_id: cid,
      file_id: fid,
      source_variant: 'cv_primary',
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: 'hash-a',
      raw_output: { experiences: [{ company: 'Acme' }] },
    });
    expect(error).toBeNull();
  });

  it('content_hash is globally unique', async () => {
    const cid = await seedCandidate(svc, 'tt-ex-dup');
    const fid = await seedFile(svc, cid, 'cv/dup.pdf');
    await seedExtraction(svc, cid, fid, 'hash-dup');
    const { error } = await svc.from('candidate_extractions').insert({
      candidate_id: cid,
      file_id: fid,
      source_variant: 'cv_primary',
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: 'hash-dup',
      raw_output: {},
    });
    expect(error).not.toBeNull();
  });

  it('rejects invalid source_variant', async () => {
    const cid = await seedCandidate(svc, 'tt-ex-v');
    const fid = await seedFile(svc, cid, 'cv/v.pdf');
    const { error } = await svc.from('candidate_extractions').insert({
      candidate_id: cid,
      file_id: fid,
      source_variant: 'github_profile' as 'cv_primary', // invalid
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: 'hash-v',
      raw_output: {},
    });
    expect(error).not.toBeNull();
  });

  it('raw_output is immutable post-insert (service role too)', async () => {
    // Even the service role (which bypasses RLS) must be blocked from
    // mutating raw_output — the trigger runs at the DB level. This is
    // the key invariant: once extracted, the raw payload is frozen.
    const cid = await seedCandidate(svc, 'tt-ex-imm');
    const fid = await seedFile(svc, cid, 'cv/imm.pdf');
    const extractionId = await seedExtraction(svc, cid, fid, 'hash-imm', 'cv_primary', {
      experiences: [{ company: 'Original' }],
    });
    const { error } = await svc
      .from('candidate_extractions')
      .update({ raw_output: { experiences: [{ company: 'Tampered' }] } })
      .eq('id', extractionId);
    expect(error).not.toBeNull();
  });

  it('non-raw_output columns can be updated by admin', async () => {
    // The trigger gates only raw_output. extracted_at can be touched
    // if the worker re-stamps a row (same content_hash re-run).
    const cid = await seedCandidate(svc, 'tt-ex-upd');
    const fid = await seedFile(svc, cid, 'cv/upd.pdf');
    const extractionId = await seedExtraction(svc, cid, fid, 'hash-upd');
    const { error } = await svc
      .from('candidate_extractions')
      .update({ extracted_at: new Date().toISOString() })
      .eq('id', extractionId);
    expect(error).toBeNull();
  });

  it('cascades on candidate delete', async () => {
    const cid = await seedCandidate(svc, 'tt-ex-cc');
    const fid = await seedFile(svc, cid, 'cv/cc.pdf');
    await seedExtraction(svc, cid, fid, 'hash-cc');
    await svc.from('candidates').delete().eq('id', cid);
    const { data } = await svc
      .from('candidate_extractions')
      .select('id')
      .eq('content_hash', 'hash-cc');
    expect((data ?? []).length).toBe(0);
  });
});
