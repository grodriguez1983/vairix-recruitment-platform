/**
 * RED — ADR-033 §RPC #1 `match_pre_filter`.
 *
 * The matching pipeline today loads the candidate universe + must-have
 * coverage from supabase-js (`db-deps.ts`), then derives included +
 * excluded in JS (`pre-filter.ts`). At ~5_000+ candidates that incurs
 * ~50 round-trips against Supabase and blows the Heroku H12 budget
 * (see ADR-031 + ADR-032 validation, 2026-05-21).
 *
 * Plan B (ADR-033) moves preFilter to a single plpgsql function and
 * lets the client receive `{ included, excluded }` in one JSONB
 * response. These tests pin the contract of that RPC.
 *
 * RED state: until the migration creates `match_pre_filter`, every
 * test fails with `function ... does not exist`. GREEN: migration
 * applied, all tests pass, semantics match `preFilterByMustHave` in
 * `src/lib/matching/pre-filter.ts` (the JS reference impl).
 *
 * Slow by design (multi-candidate fixture). Kept under 60 s on the
 * local supabase-test stack.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { serviceClient } from '../../rls/helpers';

const FIXTURE_TT_PREFIX = 'adr033-pf-';
const FIXTURE_SKILL_SLUG_PREFIX = 'adr033-pf-skill-';

interface SeededCandidate {
  id: string;
  label: 'A' | 'B' | 'C' | 'D' | 'E';
}

interface SeededSkill {
  id: string;
  slug: string;
}

async function deleteFixtureArtifacts(db: SupabaseClient): Promise<void> {
  await db.from('candidates').delete().like('teamtailor_id', `${FIXTURE_TT_PREFIX}%`);
  await db.from('skills').delete().like('slug', `${FIXTURE_SKILL_SLUG_PREFIX}%`);
}

async function insertOne(
  db: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  returning = 'id',
): Promise<Record<string, unknown>> {
  const { data, error } = await db.from(table).insert(row).select(returning).single();
  if (error || !data) throw new Error(`insert ${table}: ${error?.message ?? 'no data'}`);
  return data as unknown as Record<string, unknown>;
}

async function seedSkill(db: SupabaseClient, name: string): Promise<SeededSkill> {
  const slug = `${FIXTURE_SKILL_SLUG_PREFIX}${name}`;
  const row = await insertOne(db, 'skills', { canonical_name: name, slug }, 'id, slug');
  return { id: row.id as string, slug: row.slug as string };
}

/** Seed a candidate with a single experience and the given covered
 *  skill_ids on that experience. An empty skill_ids array seeds the
 *  candidate without any experience_skills row (still gets an
 *  experience so the FK chain is intact). */
async function seedCandidate(
  db: SupabaseClient,
  label: SeededCandidate['label'],
  coveredSkillIds: string[],
): Promise<SeededCandidate> {
  const ttId = `${FIXTURE_TT_PREFIX}${label}`;
  const cand = await insertOne(
    db,
    'candidates',
    { teamtailor_id: ttId, first_name: 'PF', last_name: `Cand-${label}` },
    'id',
  );
  const candidateId = cand.id as string;
  const file = await insertOne(
    db,
    'files',
    { candidate_id: candidateId, storage_path: `cv/${ttId}.pdf` },
    'id',
  );
  const extraction = await insertOne(
    db,
    'candidate_extractions',
    {
      candidate_id: candidateId,
      file_id: file.id as string,
      source_variant: 'cv_primary',
      model: 'stub-extract-v1',
      prompt_version: 'stub-extract-prompt-v1',
      content_hash: `adr033-pf-${label}`,
      raw_output: {},
    },
    'id',
  );
  const experience = await insertOne(
    db,
    'candidate_experiences',
    {
      candidate_id: candidateId,
      extraction_id: extraction.id as string,
      source_variant: 'cv_primary',
      kind: 'work',
      company: `Co-${label}`,
      title: 'Engineer',
      start_date: '2022-01-01',
      end_date: null,
    },
    'id',
  );
  for (const skillId of coveredSkillIds) {
    await db.from('experience_skills').insert({
      experience_id: experience.id as string,
      skill_raw: 'stub',
      skill_id: skillId,
    });
  }
  return { id: candidateId, label };
}

describe('match_pre_filter RPC — ADR-033 §RPC #1', () => {
  const db = serviceClient();
  let skillLaravel: SeededSkill;
  let skillPhp: SeededSkill;
  let skillReact: SeededSkill;
  let candA: SeededCandidate; // laravel + react
  let candB: SeededCandidate; // laravel + php
  let candC: SeededCandidate; // react only
  let candD: SeededCandidate; // php only
  let candE: SeededCandidate; // no skills

  beforeAll(async () => {
    await deleteFixtureArtifacts(db);
    skillLaravel = await seedSkill(db, 'laravel');
    skillPhp = await seedSkill(db, 'php');
    skillReact = await seedSkill(db, 'react');
    candA = await seedCandidate(db, 'A', [skillLaravel.id, skillReact.id]);
    candB = await seedCandidate(db, 'B', [skillLaravel.id, skillPhp.id]);
    candC = await seedCandidate(db, 'C', [skillReact.id]);
    candD = await seedCandidate(db, 'D', [skillPhp.id]);
    candE = await seedCandidate(db, 'E', []);
  }, 60_000);

  afterAll(async () => {
    await deleteFixtureArtifacts(db);
  });

  /** Helper — call the RPC and narrow the fixture's candidates out
   *  of the global pool (the test DB may carry leftover rows from
   *  other suites; we always filter by `teamtailor_id` prefix). */
  async function callRpc(groups: Array<{ skill_ids: string[] }>): Promise<{
    included: string[];
    excluded: Array<{ candidate_id: string; missing_must_have_skill_ids: string[] }>;
  }> {
    const { data, error } = await db.rpc('match_pre_filter', {
      must_have_groups_in: groups,
      tenant_id_in: null,
    });
    if (error) throw new Error(`match_pre_filter rpc: ${error.message}`);
    const payload = data as {
      included?: string[];
      excluded?: Array<{ candidate_id: string; missing_must_have_skill_ids: string[] }>;
    };
    const fixtureIds = new Set([candA.id, candB.id, candC.id, candD.id, candE.id]);
    return {
      included: (payload.included ?? []).filter((id) => fixtureIds.has(id)),
      excluded: (payload.excluded ?? []).filter((e) => fixtureIds.has(e.candidate_id)),
    };
  }

  it('empty must_have_groups → all fixture candidates included, excluded empty', async () => {
    const { included, excluded } = await callRpc([]);
    expect(new Set(included)).toEqual(new Set([candA.id, candB.id, candC.id, candD.id, candE.id]));
    expect(excluded).toEqual([]);
  });

  it('single group [laravel] → included covers candidates with laravel', async () => {
    const { included, excluded } = await callRpc([{ skill_ids: [skillLaravel.id] }]);
    // A (laravel+react) and B (laravel+php) cover laravel.
    expect(new Set(included)).toEqual(new Set([candA.id, candB.id]));
    // C, D, E miss laravel.
    const excludedIds = new Set(excluded.map((e) => e.candidate_id));
    expect(excludedIds).toEqual(new Set([candC.id, candD.id, candE.id]));
    for (const e of excluded) {
      expect(e.missing_must_have_skill_ids).toEqual([skillLaravel.id]);
    }
  });

  it('alternative group [react | laravel] (OR within) → A, B, C included', async () => {
    const { included } = await callRpc([{ skill_ids: [skillReact.id, skillLaravel.id] }]);
    expect(new Set(included)).toEqual(new Set([candA.id, candB.id, candC.id]));
  });

  it('AND between groups [laravel] AND [react] → only A included', async () => {
    const { included, excluded } = await callRpc([
      { skill_ids: [skillLaravel.id] },
      { skill_ids: [skillReact.id] },
    ]);
    expect(included).toEqual([candA.id]);
    const excludedIds = new Set(excluded.map((e) => e.candidate_id));
    expect(excludedIds).toEqual(new Set([candB.id, candC.id, candD.id, candE.id]));
  });

  it('excluded carries the union of missing skill_ids across failed groups', async () => {
    // candB has laravel+php → covers group [laravel]; misses [react].
    // candC has react → covers [react]; misses [laravel].
    // candD has php → misses both.
    const { excluded } = await callRpc([
      { skill_ids: [skillLaravel.id] },
      { skill_ids: [skillReact.id] },
    ]);
    const byCandidate = new Map(
      excluded.map((e) => [e.candidate_id, e.missing_must_have_skill_ids]),
    );
    expect(new Set(byCandidate.get(candB.id))).toEqual(new Set([skillReact.id]));
    expect(new Set(byCandidate.get(candC.id))).toEqual(new Set([skillLaravel.id]));
    expect(new Set(byCandidate.get(candD.id))).toEqual(new Set([skillLaravel.id, skillReact.id]));
    expect(new Set(byCandidate.get(candE.id))).toEqual(new Set([skillLaravel.id, skillReact.id]));
  });

  it('candidate with NO experience_skills row is treated as missing every group', async () => {
    // candE has the experience FK chain but no experience_skills.
    const { excluded } = await callRpc([{ skill_ids: [skillPhp.id] }]);
    const eRow = excluded.find((e) => e.candidate_id === candE.id);
    expect(eRow).toBeDefined();
    expect(eRow!.missing_must_have_skill_ids).toEqual([skillPhp.id]);
  });

  it('included candidate appears at most once even with multiple covering rows', async () => {
    // candA has laravel + react. Group [laravel|react] hits both.
    // No duplicates in `included`.
    const { included } = await callRpc([{ skill_ids: [skillLaravel.id, skillReact.id] }]);
    const aOccurrences = included.filter((id) => id === candA.id);
    expect(aOccurrences).toHaveLength(1);
  });
});
