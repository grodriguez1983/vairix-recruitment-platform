/**
 * Integration tests for the rejection normalizer orchestrator.
 *
 * Seeds evaluations with free-text `rejection_reason`, runs the
 * normalizer, and verifies `rejection_category_id` +
 * `normalization_attempted_at` + `needs_review` get set correctly.
 *
 * Uses service-role client to bypass RLS: the normalizer is an
 * internal ETL-class job (ADR-007 §2), not a user-triggered flow.
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { normalizeRejections } from '../../../src/lib/normalization/normalizer';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const db = svc();
const PREFIX = 'rejtest-';
const CAND_TT_IDS = [`${PREFIX}c1`, `${PREFIX}c2`, `${PREFIX}c3`, `${PREFIX}c4`];

interface Seeded {
  candidateIds: string[];
  categoryIds: Record<string, string>;
}

async function setup(): Promise<Seeded> {
  await db.from('evaluations').delete().like('teamtailor_id', `${PREFIX}%`);
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);

  const { data: cands, error: cErr } = await db
    .from('candidates')
    .insert(
      CAND_TT_IDS.map((tt, i) => ({
        teamtailor_id: tt,
        first_name: `R${i + 1}`,
        last_name: 'Test',
        email: `${tt}@example.test`,
        raw_data: {},
      })),
    )
    .select('id, teamtailor_id');
  if (cErr) throw cErr;
  const ordered = (cands ?? [])
    .slice()
    .sort((a, b) => (a.teamtailor_id as string).localeCompare(b.teamtailor_id as string));

  const { data: cats, error: catErr } = await db.from('rejection_categories').select('id, code');
  if (catErr) throw catErr;
  const categoryIds: Record<string, string> = {};
  for (const row of cats ?? []) {
    categoryIds[row.code as string] = row.id as string;
  }

  return {
    candidateIds: ordered.map((c) => c.id as string),
    categoryIds,
  };
}

async function cleanup(): Promise<void> {
  await db.from('evaluations').delete().like('teamtailor_id', `${PREFIX}%`);
  await db.from('candidates').delete().in('teamtailor_id', CAND_TT_IDS);
}

describe('normalizeRejections', () => {
  afterAll(cleanup);

  let candidateIds: string[];
  let categoryIds: Record<string, string>;

  beforeEach(async () => {
    const s = await setup();
    candidateIds = s.candidateIds;
    categoryIds = s.categoryIds;
  });

  it('classifies pending evaluations, updates category + timestamp', async () => {
    // Four evaluations covering: match, match, no-match (→ other), and no rejection (skip).
    const { error } = await db.from('evaluations').insert([
      {
        teamtailor_id: `${PREFIX}ev1`,
        candidate_id: candidateIds[0],
        decision: 'reject',
        rejection_reason: 'Technical skills below bar',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}ev2`,
        candidate_id: candidateIds[1],
        decision: 'reject',
        rejection_reason: 'Pretensión salarial muy alta',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}ev3`,
        candidate_id: candidateIds[2],
        decision: 'reject',
        rejection_reason: 'La vibra no pegó con el team',
        raw_data: {},
      },
      {
        teamtailor_id: `${PREFIX}ev4`,
        candidate_id: candidateIds[3],
        decision: 'pending',
        rejection_reason: null,
        raw_data: {},
      },
    ]);
    if (error) throw error;

    const res = await normalizeRejections(db);

    // ev1, ev2, ev3 processed; ev4 skipped (no reason).
    expect(res.processed).toBe(3);
    expect(res.matched).toBe(2);
    expect(res.unmatched).toBe(1);

    const { data } = await db
      .from('evaluations')
      .select('teamtailor_id, rejection_category_id, needs_review, normalization_attempted_at')
      .like('teamtailor_id', `${PREFIX}%`)
      .order('teamtailor_id', { ascending: true });

    const byId = new Map((data ?? []).map((r) => [r.teamtailor_id as string, r] as const));

    expect(byId.get(`${PREFIX}ev1`)?.rejection_category_id).toBe(categoryIds.technical_skills);
    expect(byId.get(`${PREFIX}ev1`)?.needs_review).toBe(false);
    expect(byId.get(`${PREFIX}ev1`)?.normalization_attempted_at).not.toBeNull();

    expect(byId.get(`${PREFIX}ev2`)?.rejection_category_id).toBe(categoryIds.salary_expectations);
    expect(byId.get(`${PREFIX}ev2`)?.needs_review).toBe(false);

    expect(byId.get(`${PREFIX}ev3`)?.rejection_category_id).toBe(categoryIds.other);
    expect(byId.get(`${PREFIX}ev3`)?.needs_review).toBe(true);

    expect(byId.get(`${PREFIX}ev4`)?.rejection_category_id).toBeNull();
    expect(byId.get(`${PREFIX}ev4`)?.normalization_attempted_at).toBeNull();
  });

  it('is idempotent: re-running skips already-normalized rows', async () => {
    await db.from('evaluations').insert({
      teamtailor_id: `${PREFIX}idem`,
      candidate_id: candidateIds[0],
      decision: 'reject',
      rejection_reason: 'Communication issues',
      raw_data: {},
    });

    const first = await normalizeRejections(db);
    expect(first.processed).toBe(1);

    const second = await normalizeRejections(db);
    // Already has a category + timestamp → skipped.
    expect(second.processed).toBe(0);
  });

  it('reclassifies a row when force=true', async () => {
    const { data: ins } = await db
      .from('evaluations')
      .insert({
        teamtailor_id: `${PREFIX}force`,
        candidate_id: candidateIds[0],
        decision: 'reject',
        rejection_reason: 'Salary out of budget',
        raw_data: {},
      })
      .select('id')
      .single();

    await normalizeRejections(db);

    // Mutate rejection_reason to something that now matches another rule.
    await db
      .from('evaluations')
      .update({ rejection_reason: 'Time zone mismatch' })
      .eq('id', ins!.id);

    const res = await normalizeRejections(db, { force: true });
    expect(res.processed).toBeGreaterThanOrEqual(1);

    const { data: after } = await db
      .from('evaluations')
      .select('rejection_category_id')
      .eq('id', ins!.id)
      .single();
    expect(after?.rejection_category_id).toBe(categoryIds.location);
  });
});
