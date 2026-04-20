/**
 * RLS + immutability tests for `match_runs` + `match_results` (ADR-015).
 *
 * Matrix (data-model §17):
 *   match_runs    : recruiter R (propios) | admin R/W
 *   match_results : recruiter R (propios, via match_runs) | admin R/W
 *
 * Invariants (data-model §17):
 *   - Backend INSERTs (via the API route triggered by the recruiter);
 *     recruiter can insert runs they trigger.
 *   - UPDATE únicamente para cerrar run: status 'running' →
 *     'completed' | 'failed' + finished_at stamped. No reverse
 *     transitions; no changes once closed.
 *   - breakdown_json (match_results) inmutable; match_results rows
 *     are INSERT-only (no UPDATE policy, trigger belt-and-suspenders).
 *   - Identity columns (id, job_query_id, triggered_by, started_at,
 *     catalog_snapshot_at, created_at) immutable always.
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { anonClient, makeRoleClient, resetRlsState, serviceClient } from './helpers';

// ────────────────────────────────────────────────────────────────
// Seed helpers
// ────────────────────────────────────────────────────────────────

async function seedJobQuery(
  svc: ReturnType<typeof serviceClient>,
  hash: string,
  createdBy: string | null,
): Promise<string> {
  const { data, error } = await svc
    .from('job_queries')
    .insert({
      created_by: createdBy,
      raw_text: 'JD',
      normalized_text: `jd-${hash}`,
      content_hash: hash,
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      decomposed_json: { requirements: [] },
      resolved_json: { requirements: [] },
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed job_query failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

async function seedCandidate(svc: ReturnType<typeof serviceClient>, ttId: string): Promise<string> {
  const { data, error } = await svc
    .from('candidates')
    .insert({ teamtailor_id: ttId, first_name: 'C' })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed candidate failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

type RunOverrides = {
  triggeredBy?: string | null;
  status?: 'running' | 'completed' | 'failed';
  finishedAt?: string | null;
};

async function seedRun(
  svc: ReturnType<typeof serviceClient>,
  jobQueryId: string,
  overrides: RunOverrides = {},
): Promise<string> {
  const { data, error } = await svc
    .from('match_runs')
    .insert({
      job_query_id: jobQueryId,
      triggered_by: overrides.triggeredBy ?? null,
      status: overrides.status ?? 'running',
      finished_at: overrides.finishedAt ?? null,
      catalog_snapshot_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed match_run failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

async function seedResult(
  svc: ReturnType<typeof serviceClient>,
  runId: string,
  candidateId: string,
  rank = 1,
  gate: 'passed' | 'failed' = 'passed',
): Promise<void> {
  const { error } = await svc.from('match_results').insert({
    match_run_id: runId,
    candidate_id: candidateId,
    total_score: 85.5,
    must_have_gate: gate,
    rank,
    breakdown_json: { requirements: [], notes: 'seed' },
  });
  if (error) throw new Error(`seed match_result failed: ${error.message}`);
}

// ────────────────────────────────────────────────────────────────
// match_runs
// ────────────────────────────────────────────────────────────────

describe('rls: match_runs', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('match_results').delete().neq('rank', -1);
    await svc.from('match_runs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('job_queries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('match_results').delete().neq('rank', -1);
    await svc.from('match_runs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('job_queries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const jq = await seedJobQuery(svc, 'h-run-anon', null);
    await seedRun(svc, jq);
    const { data } = await anonClient().from('match_runs').select('id');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads own runs only', async () => {
    const { client: clientA, appUserId: uidA } = await makeRoleClient('recruiter');
    const { client: clientB } = await makeRoleClient('recruiter');
    const jqA = await seedJobQuery(svc, 'h-run-A', uidA);
    const jqB = await seedJobQuery(svc, 'h-run-B', null);
    const runA = await seedRun(svc, jqA, { triggeredBy: uidA });
    await seedRun(svc, jqB, { triggeredBy: null });

    const { data: aView } = await clientA.from('match_runs').select('id');
    expect((aView ?? []).map((r) => r.id)).toEqual([runA]);

    const { data: bView } = await clientB.from('match_runs').select('id');
    expect((bView ?? []).length).toBe(0);
  });

  it('recruiter can insert a run they trigger', async () => {
    const { client, appUserId } = await makeRoleClient('recruiter');
    const jq = await seedJobQuery(svc, 'h-run-ins', appUserId);
    const { error } = await client.from('match_runs').insert({
      job_query_id: jq,
      triggered_by: appUserId,
      catalog_snapshot_at: new Date().toISOString(),
    });
    expect(error).toBeNull();
  });

  it('recruiter cannot insert with forged triggered_by', async () => {
    const { client } = await makeRoleClient('recruiter');
    const { appUserId: otherUid } = await makeRoleClient('recruiter');
    const jq = await seedJobQuery(svc, 'h-run-forge', otherUid);
    const { error } = await client.from('match_runs').insert({
      job_query_id: jq,
      triggered_by: otherUid,
      catalog_snapshot_at: new Date().toISOString(),
    });
    expect(error).not.toBeNull();
  });

  it('recruiter cannot delete (admin-only)', async () => {
    const { client, appUserId } = await makeRoleClient('recruiter');
    const jq = await seedJobQuery(svc, 'h-run-del', appUserId);
    const runId = await seedRun(svc, jq, { triggeredBy: appUserId });

    const { error, data } = await client.from('match_runs').delete().eq('id', runId).select('id');
    expect(error !== null || (data?.length ?? 0) === 0).toBe(true);

    const { data: still } = await svc.from('match_runs').select('id').eq('id', runId).single();
    expect(still?.id).toBe(runId);
  });

  it('admin can read all, insert, update and delete', async () => {
    const jq = await seedJobQuery(svc, 'h-run-adm', null);
    const runId = await seedRun(svc, jq);

    const { client } = await makeRoleClient('admin');

    const { data: view } = await client.from('match_runs').select('id');
    expect((view ?? []).map((r) => r.id)).toContain(runId);

    const { error: updErr } = await client
      .from('match_runs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        candidates_evaluated: 42,
      })
      .eq('id', runId);
    expect(updErr).toBeNull();

    const { error: delErr } = await client.from('match_runs').delete().eq('id', runId);
    expect(delErr).toBeNull();
  });

  // ────────────────────────────────────────────────────────────────
  // Invariants (trigger — apply to service role too)
  // ────────────────────────────────────────────────────────────────

  it('allows closing a running run: status → completed + finished_at stamped', async () => {
    const jq = await seedJobQuery(svc, 'h-close-ok', null);
    const runId = await seedRun(svc, jq);
    const { error } = await svc
      .from('match_runs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        candidates_evaluated: 10,
      })
      .eq('id', runId);
    expect(error).toBeNull();
  });

  it('allows closing a running run with status=failed', async () => {
    const jq = await seedJobQuery(svc, 'h-close-fail', null);
    const runId = await seedRun(svc, jq);
    const { error } = await svc
      .from('match_runs')
      .update({
        status: 'failed',
        finished_at: new Date().toISOString(),
        diagnostics: { error: 'timeout' },
      })
      .eq('id', runId);
    expect(error).toBeNull();
  });

  it('rejects closing without finished_at', async () => {
    const jq = await seedJobQuery(svc, 'h-close-nofin', null);
    const runId = await seedRun(svc, jq);
    const { error } = await svc.from('match_runs').update({ status: 'completed' }).eq('id', runId);
    expect(error).not.toBeNull();
  });

  it('rejects reopening a closed run (completed → running)', async () => {
    const jq = await seedJobQuery(svc, 'h-reopen', null);
    const runId = await seedRun(svc, jq);
    await svc
      .from('match_runs')
      .update({ status: 'completed', finished_at: new Date().toISOString() })
      .eq('id', runId);

    const { error } = await svc
      .from('match_runs')
      .update({ status: 'running', finished_at: null })
      .eq('id', runId);
    expect(error).not.toBeNull();
  });

  it('rejects flipping a closed run completed↔failed', async () => {
    const jq = await seedJobQuery(svc, 'h-flip', null);
    const runId = await seedRun(svc, jq);
    await svc
      .from('match_runs')
      .update({ status: 'completed', finished_at: new Date().toISOString() })
      .eq('id', runId);
    const { error } = await svc.from('match_runs').update({ status: 'failed' }).eq('id', runId);
    expect(error).not.toBeNull();
  });

  it('rejects mutating a closed run (diagnostics, candidates_evaluated)', async () => {
    const jq = await seedJobQuery(svc, 'h-closed-frozen', null);
    const runId = await seedRun(svc, jq);
    await svc
      .from('match_runs')
      .update({
        status: 'completed',
        finished_at: new Date().toISOString(),
        candidates_evaluated: 10,
        diagnostics: { note: 'ok' },
      })
      .eq('id', runId);

    const { error: evalErr } = await svc
      .from('match_runs')
      .update({ candidates_evaluated: 99 })
      .eq('id', runId);
    expect(evalErr).not.toBeNull();

    const { error: diagErr } = await svc
      .from('match_runs')
      .update({ diagnostics: { note: 'tampered' } })
      .eq('id', runId);
    expect(diagErr).not.toBeNull();
  });

  it('freezes identity columns even while running', async () => {
    const jq1 = await seedJobQuery(svc, 'h-id-a', null);
    const jq2 = await seedJobQuery(svc, 'h-id-b', null);
    const runId = await seedRun(svc, jq1);

    const { error: jqErr } = await svc
      .from('match_runs')
      .update({ job_query_id: jq2 })
      .eq('id', runId);
    expect(jqErr).not.toBeNull();

    const { error: startErr } = await svc
      .from('match_runs')
      .update({ started_at: new Date(0).toISOString() })
      .eq('id', runId);
    expect(startErr).not.toBeNull();

    const { error: snapErr } = await svc
      .from('match_runs')
      .update({ catalog_snapshot_at: new Date(0).toISOString() })
      .eq('id', runId);
    expect(snapErr).not.toBeNull();
  });

  it('allows updating candidates_evaluated + diagnostics while running', async () => {
    const jq = await seedJobQuery(svc, 'h-running-update', null);
    const runId = await seedRun(svc, jq);
    const { error } = await svc
      .from('match_runs')
      .update({ candidates_evaluated: 5, diagnostics: { progress: 'halfway' } })
      .eq('id', runId);
    expect(error).toBeNull();
  });
});

// ────────────────────────────────────────────────────────────────
// match_results
// ────────────────────────────────────────────────────────────────

describe('rls: match_results', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    await resetRlsState(svc);
    await svc.from('match_results').delete().neq('rank', -1);
    await svc.from('match_runs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('job_queries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('match_results').delete().neq('rank', -1);
    await svc.from('match_runs').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('job_queries').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await resetRlsState(svc);
  });

  it('denies anonymous select', async () => {
    const jq = await seedJobQuery(svc, 'h-res-anon', null);
    const runId = await seedRun(svc, jq);
    const cid = await seedCandidate(svc, 'tt-res-anon');
    await seedResult(svc, runId, cid);
    const { data } = await anonClient().from('match_results').select('rank');
    expect(data?.length ?? 0).toBe(0);
  });

  it('recruiter reads results of own runs only', async () => {
    const { client: clientA, appUserId: uidA } = await makeRoleClient('recruiter');
    const { client: clientB } = await makeRoleClient('recruiter');

    const jqA = await seedJobQuery(svc, 'h-res-A', uidA);
    const runA = await seedRun(svc, jqA, { triggeredBy: uidA });
    const cidA = await seedCandidate(svc, 'tt-res-A');
    await seedResult(svc, runA, cidA, 1);

    const jqB = await seedJobQuery(svc, 'h-res-B', null);
    const runB = await seedRun(svc, jqB, { triggeredBy: null });
    const cidB = await seedCandidate(svc, 'tt-res-B');
    await seedResult(svc, runB, cidB, 1);

    const { data: aView } = await clientA.from('match_results').select('match_run_id, rank');
    expect((aView ?? []).map((r) => r.match_run_id)).toEqual([runA]);

    const { data: bView } = await clientB.from('match_results').select('rank');
    expect((bView ?? []).length).toBe(0);
  });

  it('recruiter cannot insert results (backend-only via service role)', async () => {
    const { client, appUserId } = await makeRoleClient('recruiter');
    const jq = await seedJobQuery(svc, 'h-res-ins', appUserId);
    const runId = await seedRun(svc, jq, { triggeredBy: appUserId });
    const cid = await seedCandidate(svc, 'tt-res-ins');

    const { error } = await client.from('match_results').insert({
      match_run_id: runId,
      candidate_id: cid,
      total_score: 50,
      must_have_gate: 'passed',
      rank: 1,
      breakdown_json: {},
    });
    expect(error).not.toBeNull();
  });

  it('admin can insert and delete', async () => {
    const jq = await seedJobQuery(svc, 'h-res-adm', null);
    const runId = await seedRun(svc, jq);
    const cid = await seedCandidate(svc, 'tt-res-adm');

    const { client } = await makeRoleClient('admin');
    const { error: insErr } = await client.from('match_results').insert({
      match_run_id: runId,
      candidate_id: cid,
      total_score: 90,
      must_have_gate: 'passed',
      rank: 1,
      breakdown_json: { tag: 'admin-wrote' },
    });
    expect(insErr).toBeNull();

    const { error: delErr } = await client
      .from('match_results')
      .delete()
      .eq('match_run_id', runId)
      .eq('candidate_id', cid);
    expect(delErr).toBeNull();
  });

  it('rejects any UPDATE on match_results (rows are insert-only)', async () => {
    const jq = await seedJobQuery(svc, 'h-res-imm', null);
    const runId = await seedRun(svc, jq);
    const cid = await seedCandidate(svc, 'tt-res-imm');
    await seedResult(svc, runId, cid);

    const { error: scoreErr } = await svc
      .from('match_results')
      .update({ total_score: 0.01 })
      .eq('match_run_id', runId)
      .eq('candidate_id', cid);
    expect(scoreErr).not.toBeNull();

    const { error: bdErr } = await svc
      .from('match_results')
      .update({ breakdown_json: { tampered: true } })
      .eq('match_run_id', runId)
      .eq('candidate_id', cid);
    expect(bdErr).not.toBeNull();

    const { error: rankErr } = await svc
      .from('match_results')
      .update({ rank: 999 })
      .eq('match_run_id', runId)
      .eq('candidate_id', cid);
    expect(rankErr).not.toBeNull();
  });

  it('rejects invalid must_have_gate value', async () => {
    const jq = await seedJobQuery(svc, 'h-res-gate', null);
    const runId = await seedRun(svc, jq);
    const cid = await seedCandidate(svc, 'tt-res-gate');
    const { error } = await svc.from('match_results').insert({
      match_run_id: runId,
      candidate_id: cid,
      total_score: 50,
      must_have_gate: 'maybe' as 'passed', // invalid check constraint
      rank: 1,
      breakdown_json: {},
    });
    expect(error).not.toBeNull();
  });

  it('enforces composite PK (match_run_id, candidate_id)', async () => {
    const jq = await seedJobQuery(svc, 'h-res-pk', null);
    const runId = await seedRun(svc, jq);
    const cid = await seedCandidate(svc, 'tt-res-pk');
    await seedResult(svc, runId, cid, 1);
    const { error } = await svc.from('match_results').insert({
      match_run_id: runId,
      candidate_id: cid,
      total_score: 10,
      must_have_gate: 'passed',
      rank: 2,
      breakdown_json: {},
    });
    expect(error).not.toBeNull();
  });

  it('cascades on match_run delete', async () => {
    const jq = await seedJobQuery(svc, 'h-res-cc', null);
    const runId = await seedRun(svc, jq);
    const cid = await seedCandidate(svc, 'tt-res-cc');
    await seedResult(svc, runId, cid);
    await svc.from('match_runs').delete().eq('id', runId);
    const { data } = await svc.from('match_results').select('rank').eq('match_run_id', runId);
    expect((data ?? []).length).toBe(0);
  });
});
