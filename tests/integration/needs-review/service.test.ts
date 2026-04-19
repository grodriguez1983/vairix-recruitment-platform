/**
 * Integration tests for the needs-review admin service (F2-004).
 *
 * Covers list, count, reclassifyAndClear (success + invalid category +
 * already cleared), dismissAndClear (success + already cleared).
 */
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  countNeedsReview,
  dismissAndClear,
  listNeedsReview,
  listRejectionCategories,
  reclassifyAndClear,
} from '../../../src/lib/needs-review/service';
import { NeedsReviewAdminError } from '../../../src/lib/needs-review/errors';

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
const PREFIX = 'nrtest-';

interface Seeded {
  evaluationIds: string[];
  candidateId: string;
  otherId: string;
  technicalSkillsId: string;
}

async function cleanup(): Promise<void> {
  await db.from('evaluations').delete().like('teamtailor_id', `${PREFIX}%`);
  await db.from('candidates').delete().like('teamtailor_id', `${PREFIX}%`);
}

async function setup(): Promise<Seeded> {
  await cleanup();

  const { data: cand, error: cErr } = await db
    .from('candidates')
    .insert({ teamtailor_id: `${PREFIX}c1`, first_name: 'NR', last_name: 'Test' })
    .select('id')
    .single();
  if (cErr || !cand) throw cErr ?? new Error('seed candidate failed');

  const { data: cats, error: catErr } = await db.from('rejection_categories').select('id, code');
  if (catErr) throw catErr;
  const byCode = new Map((cats ?? []).map((c) => [c.code as string, c.id as string]));
  const otherId = byCode.get('other');
  const technicalSkillsId = byCode.get('technical_skills');
  if (!otherId || !technicalSkillsId) throw new Error('missing seeded categories');

  const { data: evs, error: evErr } = await db
    .from('evaluations')
    .insert([
      {
        teamtailor_id: `${PREFIX}ev1`,
        candidate_id: cand.id,
        decision: 'reject',
        rejection_reason: 'Vibra rara',
        rejection_category_id: otherId,
        needs_review: true,
        normalization_attempted_at: new Date().toISOString(),
      },
      {
        teamtailor_id: `${PREFIX}ev2`,
        candidate_id: cand.id,
        decision: 'reject',
        rejection_reason: 'Otra cosa',
        rejection_category_id: otherId,
        needs_review: true,
        normalization_attempted_at: new Date().toISOString(),
      },
    ])
    .select('id, teamtailor_id')
    .order('teamtailor_id', { ascending: true });
  if (evErr || !evs) throw evErr ?? new Error('seed evals failed');

  return {
    evaluationIds: evs.map((e) => e.id as string),
    candidateId: cand.id as string,
    otherId,
    technicalSkillsId,
  };
}

describe('needs-review service', () => {
  let seeded: Seeded;

  afterAll(cleanup);

  beforeEach(async () => {
    seeded = await setup();
  });

  it('lists pending rows and includes joined candidate name', async () => {
    const rows = await listNeedsReview(db, { limit: 50 });
    const mine = rows.filter((r) => seeded.evaluationIds.includes(r.id));
    expect(mine.length).toBe(2);
    for (const r of mine) {
      expect(r.candidate_first_name).toBe('NR');
      expect(r.candidate_last_name).toBe('Test');
    }
  });

  it('counts pending rows (>= seeded count)', async () => {
    const c = await countNeedsReview(db);
    expect(c).toBeGreaterThanOrEqual(2);
  });

  it('listRejectionCategories returns the seeded set, sorted', async () => {
    const cats = await listRejectionCategories(db);
    const codes = cats.map((c) => c.code);
    expect(codes).toContain('technical_skills');
    expect(codes).toContain('other');
    // 'other' has sort_order=999 → last
    expect(codes[codes.length - 1]).toBe('other');
  });

  it('reclassifyAndClear writes new category and clears the flag', async () => {
    await reclassifyAndClear(db, seeded.evaluationIds[0]!, seeded.technicalSkillsId);
    const { data } = await db
      .from('evaluations')
      .select('rejection_category_id, needs_review')
      .eq('id', seeded.evaluationIds[0]!)
      .single();
    expect(data?.rejection_category_id).toBe(seeded.technicalSkillsId);
    expect(data?.needs_review).toBe(false);
  });

  it('reclassifyAndClear rejects an unknown category id', async () => {
    await expect(
      reclassifyAndClear(db, seeded.evaluationIds[0]!, '00000000-0000-0000-0000-000000000000'),
    ).rejects.toBeInstanceOf(NeedsReviewAdminError);
  });

  it('reclassifyAndClear rejects when row already cleared', async () => {
    await db.from('evaluations').update({ needs_review: false }).eq('id', seeded.evaluationIds[0]!);
    await expect(
      reclassifyAndClear(db, seeded.evaluationIds[0]!, seeded.technicalSkillsId),
    ).rejects.toMatchObject({ code: 'already_cleared' });
  });

  it('dismissAndClear keeps category, clears flag', async () => {
    await dismissAndClear(db, seeded.evaluationIds[1]!);
    const { data } = await db
      .from('evaluations')
      .select('rejection_category_id, needs_review')
      .eq('id', seeded.evaluationIds[1]!)
      .single();
    expect(data?.rejection_category_id).toBe(seeded.otherId);
    expect(data?.needs_review).toBe(false);
  });

  it('dismissAndClear rejects when row already cleared', async () => {
    await db.from('evaluations').update({ needs_review: false }).eq('id', seeded.evaluationIds[1]!);
    await expect(dismissAndClear(db, seeded.evaluationIds[1]!)).rejects.toMatchObject({
      code: 'already_cleared',
    });
  });
});
