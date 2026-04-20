/**
 * RLS + immutability tests for `job_queries` (ADR-014).
 *
 * Matrix (data-model §17): recruiter R/W (propios), admin R/W.
 * Invariants (data-model §17):
 *   - `decomposed_json` immutable post-insert (caché por content_hash).
 *   - `content_hash`, `normalized_text`, `model`, `prompt_version`
 *     immutable — la identidad del cache no puede retroactivarse.
 *   - `resolved_json`, `unresolved_skills`, `resolved_at`,
 *     `raw_text`, `raw_text_retained` ARE mutable:
 *       - resolved_json/unresolved_skills re-derived al re-resolver.
 *       - raw_text can be purged (policy) by flipping raw_text_retained.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

type InsertShape = {
  created_by?: string | null;
  raw_text?: string | null;
  normalized_text: string;
  content_hash: string;
  model: string;
  prompt_version: string;
  decomposed_json: Record<string, unknown>;
  resolved_json: Record<string, unknown>;
  unresolved_skills?: string[];
};

function baseRow(hash: string, overrides: Partial<InsertShape> = {}): InsertShape {
  return {
    raw_text: 'Senior React engineer, 3+ years',
    normalized_text: 'senior react engineer, 3+ years',
    content_hash: hash,
    model: 'gpt-4o-mini',
    prompt_version: '2026-04-v1',
    decomposed_json: { requirements: [{ skill_slug: 'react', years: 3 }] },
    resolved_json: { requirements: [{ skill_id: null, years: 3 }] },
    ...overrides,
  };
}

describe('rls: job_queries', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('job_queries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('job_queries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  // ────────────────────────────────────────────────────────────────
  // RLS matrix
  // ────────────────────────────────────────────────────────────────

  it('denies anonymous select', async () => {
    await svc.from('job_queries').insert(baseRow('h-anon'));
    const { data } = await anonClient().from('job_queries').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads own rows only', async () => {
    const { client: clientA, appUserId: uidA } = await makeRoleClient('recruiter');
    const { client: clientB } = await makeRoleClient('recruiter');

    // A inserts their own row
    const { error: aInsErr } = await clientA
      .from('job_queries')
      .insert(baseRow('h-own-A', { created_by: uidA }));
    expect(aInsErr).toBeNull();

    // A can see their row
    const { data: aView } = await clientA.from('job_queries').select('content_hash');
    expect((aView ?? []).some((r) => r.content_hash === 'h-own-A')).toBe(true);

    // B does NOT see A's row (ownership scoping)
    const { data: bView } = await clientB
      .from('job_queries')
      .select('content_hash')
      .eq('content_hash', 'h-own-A');
    expect((bView ?? []).length).toBe(0);
  });

  it('recruiter cannot insert a row owned by someone else', async () => {
    const { client: clientA } = await makeRoleClient('recruiter');
    const { appUserId: uidB } = await makeRoleClient('recruiter');

    const { error } = await clientA
      .from('job_queries')
      .insert(baseRow('h-forge', { created_by: uidB }));
    expect(error).not.toBeNull();
  });

  it('recruiter cannot delete own row (admin-only delete)', async () => {
    const { client, appUserId } = await makeRoleClient('recruiter');
    const { data: inserted } = await client
      .from('job_queries')
      .insert(baseRow('h-del', { created_by: appUserId }))
      .select('id')
      .single();
    const rowId = inserted!.id;

    const { error, data } = await client.from('job_queries').delete().eq('id', rowId).select('id');
    expect(error !== null || (data?.length ?? 0) === 0).toBe(true);

    const { data: stillThere } = await svc
      .from('job_queries')
      .select('id')
      .eq('id', rowId)
      .single();
    expect(stillThere?.id).toBe(rowId);
  });

  it('admin reads all rows regardless of created_by', async () => {
    const { appUserId: uidR } = await makeRoleClient('recruiter');
    await svc.from('job_queries').insert(baseRow('h-admin-r1', { created_by: uidR }));
    await svc.from('job_queries').insert(baseRow('h-admin-r2', { created_by: null }));

    const { client: admin } = await makeRoleClient('admin');
    const { data } = await admin.from('job_queries').select('content_hash');
    const hashes = (data ?? []).map((r) => r.content_hash);
    expect(hashes).toEqual(expect.arrayContaining(['h-admin-r1', 'h-admin-r2']));
  });

  it('admin can insert, update resolved_json, and delete', async () => {
    const { client, appUserId } = await makeRoleClient('admin');

    const { data: inserted, error: insErr } = await client
      .from('job_queries')
      .insert(baseRow('h-adm-ok', { created_by: appUserId }))
      .select('id')
      .single();
    expect(insErr).toBeNull();
    const rowId = inserted!.id;

    const { error: updErr } = await client
      .from('job_queries')
      .update({ resolved_json: { requirements: [{ skill_id: 'new-id', years: 3 }] } })
      .eq('id', rowId);
    expect(updErr).toBeNull();

    const { error: delErr } = await client.from('job_queries').delete().eq('id', rowId);
    expect(delErr).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────
  // Constraints
  // ────────────────────────────────────────────────────────────────

  it('content_hash is globally unique', async () => {
    await svc.from('job_queries').insert(baseRow('h-dup'));
    const { error } = await svc.from('job_queries').insert(baseRow('h-dup'));
    expect(error).not.toBeNull();
  });

  it('unresolved_skills defaults to empty array', async () => {
    const { data } = await svc
      .from('job_queries')
      .insert(baseRow('h-default-arr'))
      .select('unresolved_skills')
      .single();
    expect(data?.unresolved_skills).toEqual([]);
  });

  // ────────────────────────────────────────────────────────────────
  // Immutability invariants (trigger — applies to service role too)
  // ────────────────────────────────────────────────────────────────

  it('decomposed_json is immutable post-insert', async () => {
    const { data } = await svc
      .from('job_queries')
      .insert(baseRow('h-imm-dec'))
      .select('id')
      .single();
    const { error } = await svc
      .from('job_queries')
      .update({ decomposed_json: { requirements: [] } })
      .eq('id', data!.id);
    expect(error).not.toBeNull();
  });

  it('content_hash is immutable post-insert', async () => {
    const { data } = await svc
      .from('job_queries')
      .insert(baseRow('h-imm-hash'))
      .select('id')
      .single();
    const { error } = await svc
      .from('job_queries')
      .update({ content_hash: 'h-imm-hash-rewritten' })
      .eq('id', data!.id);
    expect(error).not.toBeNull();
  });

  it('normalized_text, model, prompt_version are immutable post-insert', async () => {
    const { data } = await svc
      .from('job_queries')
      .insert(baseRow('h-imm-id'))
      .select('id')
      .single();

    const { error: normErr } = await svc
      .from('job_queries')
      .update({ normalized_text: 'tampered' })
      .eq('id', data!.id);
    expect(normErr).not.toBeNull();

    const { error: modelErr } = await svc
      .from('job_queries')
      .update({ model: 'gpt-5' })
      .eq('id', data!.id);
    expect(modelErr).not.toBeNull();

    const { error: pvErr } = await svc
      .from('job_queries')
      .update({ prompt_version: '2099-v1' })
      .eq('id', data!.id);
    expect(pvErr).not.toBeNull();
  });

  it('resolved_json IS mutable (re-resolve path)', async () => {
    const { data } = await svc
      .from('job_queries')
      .insert(baseRow('h-mut-res'))
      .select('id')
      .single();
    const { error } = await svc
      .from('job_queries')
      .update({
        resolved_json: { requirements: [{ skill_id: 'abc', years: 3 }] },
        unresolved_skills: ['new-unknown'],
        resolved_at: new Date().toISOString(),
      })
      .eq('id', data!.id);
    expect(error).toBeNull();
  });

  it('raw_text can be purged (raw_text_retained=false, raw_text=null)', async () => {
    const { data } = await svc.from('job_queries').insert(baseRow('h-purge')).select('id').single();
    const { error } = await svc
      .from('job_queries')
      .update({ raw_text: null, raw_text_retained: false })
      .eq('id', data!.id);
    expect(error).toBeNull();
  });

  it('created_by is immutable post-insert', async () => {
    // Ownership can't be transferred silently — that would bypass
    // the RLS scoping.
    const { appUserId: uidOriginal } = await makeRoleClient('recruiter');
    const { appUserId: uidOther } = await makeRoleClient('recruiter');

    const { data } = await svc
      .from('job_queries')
      .insert(baseRow('h-owner-lock', { created_by: uidOriginal }))
      .select('id')
      .single();

    const { error } = await svc
      .from('job_queries')
      .update({ created_by: uidOther })
      .eq('id', data!.id);
    expect(error).not.toBeNull();
  });
});
