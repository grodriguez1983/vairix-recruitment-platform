/**
 * F4-008 DoD integration e2e (roadmap §F4-008).
 *
 * Exercises the full pipeline against a local Supabase instance:
 *
 *   seed (skills catalog + 20 candidates with experiences/skills) →
 *   decomposeJobQuery (stub provider; no OpenAI key needed) →
 *   runMatchJob (buildRunMatchJobDeps wired against service role) →
 *   persisted match_run + match_results
 *
 * The goal is wiring validation, NOT deep ranker correctness (that is
 * covered by `src/lib/matching/*.test.ts` units). Assertions here:
 *
 *   - `match_runs.status = 'completed'` + `finished_at` stamped
 *   - `match_results` row count matches `candidates_evaluated`
 *   - `rank` column is a contiguous sequence 1..N with no gaps/ties
 *   - scores are monotonically non-increasing by rank
 *   - pre-filter drops candidates missing a must-have skill
 *   - `breakdown_json` round-trips the three expected sub-objects
 *   - the API-style response `top` slice matches DB rows 1..topN
 *
 * Seeding bypasses RLS via service role (same pattern as the
 * decomposeJobQuery integration test) — the ADR-017 insert policy
 * for recruiters has its own RLS test under `tests/rls/`.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { decomposeJobQuery } from '../../../src/lib/rag/decomposition/decompose-job-query';
import { createStubDecompositionProvider } from '../../../src/lib/rag/decomposition/stub-provider';
import type { DecompositionResult } from '../../../src/lib/rag/decomposition/types';
import type { ResolvedDecomposition } from '../../../src/lib/rag/decomposition/resolve-requirements';
import { loadCatalogSnapshot } from '../../../src/lib/skills/catalog-loader';
import { runMatchJob } from '../../../src/lib/matching/run-match-job';
import { buildRunMatchJobDeps } from '../../../src/lib/matching/db-deps';
import type {
  DecomposeJobQueryDeps,
  JobQueryInsertRow,
} from '../../../src/lib/rag/decomposition/decompose-job-query';

import { serviceClient } from '../../rls/helpers';

const TEST_EMAIL = 'f4-008-e2e@example.test';
// The resolver normalizes skill_raw via lowercase+whitespace-collapse
// but preserves internal hyphens. So to match on slug we keep the
// hyphen-token form identical between `skill_raw` and `slug`.
const SKILL_NODEJS_SLUG = 'f4008-e2e-nodejs';
const SKILL_POSTGRES_SLUG = 'f4008-e2e-postgres';
const SKILL_NODEJS_RAW = 'F4008-E2E-NodeJS';
const SKILL_POSTGRES_RAW = 'F4008-E2E-Postgres';
const SKILL_NODEJS_NAME = 'F4008 E2E NodeJS';
const SKILL_POSTGRES_NAME = 'F4008 E2E Postgres';
const FIXTURE_TT_PREFIX = 'f4-008-e2e-';

interface FixtureCandidate {
  candidate_id: string;
  nodejs_years: number;
  postgres_years: number | null; // null = no postgres experience
}

interface FixtureResult {
  candidates: FixtureCandidate[];
  nodejs_skill_id: string;
  postgres_skill_id: string;
}

async function deleteFixtureArtifacts(db: SupabaseClient): Promise<void> {
  // Candidates cascade-delete files, extractions, experiences, experience_skills.
  await db.from('candidates').delete().like('teamtailor_id', `${FIXTURE_TT_PREFIX}%`);
  await db.from('skills').delete().in('slug', [SKILL_NODEJS_SLUG, SKILL_POSTGRES_SLUG]);
}

function daysAgo(years: number): string {
  // ISO date for `years` years before today.
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}

async function seedCandidate(
  db: SupabaseClient,
  index: number,
  nodejsYears: number,
  postgresYears: number | null,
  nodejsSkillId: string,
  postgresSkillId: string,
): Promise<string> {
  const tt = `${FIXTURE_TT_PREFIX}${index.toString().padStart(3, '0')}`;
  const { data: cand, error: cErr } = await db
    .from('candidates')
    .insert({ teamtailor_id: tt, first_name: 'E2E', last_name: `Cand${index}` })
    .select('id')
    .single();
  if (cErr || !cand) throw new Error(`seed candidate ${index}: ${cErr?.message}`);
  const candidateId = cand.id as string;

  const { data: file, error: fErr } = await db
    .from('files')
    .insert({ candidate_id: candidateId, storage_path: `cv/${tt}.pdf` })
    .select('id')
    .single();
  if (fErr || !file) throw new Error(`seed file ${index}: ${fErr?.message}`);

  const { data: ex, error: eErr } = await db
    .from('candidate_extractions')
    .insert({
      candidate_id: candidateId,
      file_id: file.id,
      source_variant: 'cv_primary',
      model: 'stub-extract-v1',
      prompt_version: 'stub-extract-prompt-v1',
      content_hash: `f4008-e2e-${index}`,
      raw_output: {},
    })
    .select('id')
    .single();
  if (eErr || !ex) throw new Error(`seed extraction ${index}: ${eErr?.message}`);
  const extractionId = ex.id as string;

  // Insert one experience per skill the candidate has, so years-calculator
  // attributes the full date range to each skill via experience_skills.
  async function insertExperience(
    years: number,
    skillId: string,
    skillRaw: string,
    company: string,
  ): Promise<void> {
    const { data: exp, error: xErr } = await db
      .from('candidate_experiences')
      .insert({
        candidate_id: candidateId,
        extraction_id: extractionId,
        source_variant: 'cv_primary',
        kind: 'work',
        company,
        title: 'Engineer',
        start_date: daysAgo(years),
        end_date: null,
        description: `Worked with ${skillRaw}`,
      })
      .select('id')
      .single();
    if (xErr || !exp) throw new Error(`seed experience ${index}/${skillRaw}: ${xErr?.message}`);

    const { error: sErr } = await db
      .from('experience_skills')
      .insert({ experience_id: exp.id, skill_id: skillId, skill_raw: skillRaw });
    if (sErr) throw new Error(`seed experience_skill ${index}/${skillRaw}: ${sErr.message}`);
  }

  await insertExperience(nodejsYears, nodejsSkillId, SKILL_NODEJS_RAW, 'NodeCorp');
  if (postgresYears !== null) {
    await insertExperience(postgresYears, postgresSkillId, SKILL_POSTGRES_RAW, 'DBInc');
  }

  return candidateId;
}

async function seedFixture(db: SupabaseClient): Promise<FixtureResult> {
  // 1. Skills catalog.
  const { data: nodeSkill, error: nErr } = await db
    .from('skills')
    .insert({ slug: SKILL_NODEJS_SLUG, canonical_name: SKILL_NODEJS_NAME })
    .select('id')
    .single();
  if (nErr || !nodeSkill) throw new Error(`seed nodejs skill: ${nErr?.message}`);
  const nodejsSkillId = nodeSkill.id as string;

  const { data: pgSkill, error: pErr } = await db
    .from('skills')
    .insert({ slug: SKILL_POSTGRES_SLUG, canonical_name: SKILL_POSTGRES_NAME })
    .select('id')
    .single();
  if (pErr || !pgSkill) throw new Error(`seed postgres skill: ${pErr?.message}`);
  const postgresSkillId = pgSkill.id as string;

  // 2. 20 candidates.
  //   - 5 "strong": 8y nodejs + 8y postgres (both ratios hit 1.0)
  //   - 10 "medium": 3y nodejs + 3y postgres (at min_years)
  //   - 5 "gate-excluded": 5y nodejs only, no postgres (pre-filter drops them)
  const candidates: FixtureCandidate[] = [];
  for (let i = 0; i < 5; i += 1) {
    const cid = await seedCandidate(db, i, 8, 8, nodejsSkillId, postgresSkillId);
    candidates.push({ candidate_id: cid, nodejs_years: 8, postgres_years: 8 });
  }
  for (let i = 5; i < 15; i += 1) {
    const cid = await seedCandidate(db, i, 3, 3, nodejsSkillId, postgresSkillId);
    candidates.push({ candidate_id: cid, nodejs_years: 3, postgres_years: 3 });
  }
  for (let i = 15; i < 20; i += 1) {
    const cid = await seedCandidate(db, i, 5, null, nodejsSkillId, postgresSkillId);
    candidates.push({ candidate_id: cid, nodejs_years: 5, postgres_years: null });
  }

  return { candidates, nodejs_skill_id: nodejsSkillId, postgres_skill_id: postgresSkillId };
}

function stubFixture(): DecompositionResult {
  return {
    requirements: [
      {
        skill_raw: SKILL_NODEJS_RAW,
        min_years: 3,
        max_years: null,
        must_have: true,
        evidence_snippet: '3+ años',
        category: 'technical',
      },
      {
        skill_raw: SKILL_POSTGRES_RAW,
        min_years: 3,
        max_years: null,
        must_have: true,
        evidence_snippet: '3+ años',
        category: 'technical',
      },
    ],
    seniority: 'senior',
    languages: [],
    notes: null,
  };
}

function buildDecomposeDeps(db: SupabaseClient, createdBy: string): DecomposeJobQueryDeps {
  const provider = createStubDecompositionProvider({ fixture: stubFixture() });
  return {
    provider,
    loadCatalog: () => loadCatalogSnapshot(db),
    findByHash: async (hash) => {
      const { data, error } = await db
        .from('job_queries')
        .select('id, content_hash, decomposed_json, unresolved_skills')
        .eq('content_hash', hash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return null;
      return {
        id: data.id as string,
        content_hash: data.content_hash as string,
        decomposed_json: data.decomposed_json as DecompositionResult,
        unresolved_skills: (data.unresolved_skills as string[]) ?? [],
      };
    },
    insertJobQuery: async (row: JobQueryInsertRow) => {
      const { data, error } = await db
        .from('job_queries')
        .insert({
          content_hash: row.content_hash,
          raw_text: row.raw_text,
          normalized_text: row.normalized_text,
          model: row.model,
          prompt_version: row.prompt_version,
          decomposed_json: row.decomposed_json,
          resolved_json: row.resolved_json,
          unresolved_skills: row.unresolved_skills,
          created_by: row.created_by,
          tenant_id: row.tenant_id,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'insert failed');
      return { id: data.id as string };
    },
    updateResolved: async (id, resolved: ResolvedDecomposition, unresolved) => {
      const { error } = await db
        .from('job_queries')
        .update({
          resolved_json: resolved,
          unresolved_skills: unresolved,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    createdBy,
    tenantId: null,
  };
}

describe('runMatchJob (integration e2e — F4-008 DoD)', () => {
  const db = serviceClient();
  let appUserId: string;
  let authUserId: string;

  beforeEach(async () => {
    // Clean up any artifacts from a previous failed run.
    await db.from('app_users').delete().eq('email', TEST_EMAIL);
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of list?.users ?? []) {
      if (u.email === TEST_EMAIL) await db.auth.admin.deleteUser(u.id);
    }
    await deleteFixtureArtifacts(db);
    // job_queries has no fixture-marker; we scope by created_by below
    // after we have appUserId.

    const { data: authData, error: authErr } = await db.auth.admin.createUser({
      email: TEST_EMAIL,
      email_confirm: true,
    });
    if (authErr || !authData.user) throw new Error(`auth create: ${authErr?.message}`);
    authUserId = authData.user.id;

    const { data: appUser, error: appErr } = await db
      .from('app_users')
      .insert({ auth_user_id: authUserId, email: TEST_EMAIL, role: 'recruiter' })
      .select('id')
      .single();
    if (appErr || !appUser) throw new Error(`app_users insert: ${appErr?.message}`);
    appUserId = appUser.id as string;
  });

  afterEach(async () => {
    // Orphaned runs / job_queries from this test.
    await db.from('match_runs').delete().eq('triggered_by', appUserId);
    await db.from('job_queries').delete().eq('created_by', appUserId);
    await deleteFixtureArtifacts(db);
    await db.from('app_users').delete().eq('email', TEST_EMAIL);
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of list?.users ?? []) {
      if (u.email === TEST_EMAIL) await db.auth.admin.deleteUser(u.id);
    }
  });

  it('runs the full pipeline against 20 candidates and persists a closed run', async () => {
    const fixture = await seedFixture(db);
    const strongIds = new Set(fixture.candidates.slice(0, 5).map((c) => c.candidate_id));
    const excludedIds = new Set(fixture.candidates.slice(15, 20).map((c) => c.candidate_id));

    // 1. decompose a JD via stub provider — no OpenAI dependency.
    const rawJd = `Backend Senior con 3+ años de ${SKILL_NODEJS_RAW} y 3+ años de ${SKILL_POSTGRES_RAW}.`;
    const decomposed = await decomposeJobQuery(rawJd, buildDecomposeDeps(db, appUserId));
    expect(decomposed.unresolved_skills).toEqual([]); // both skills in the seeded catalog

    // 2. run the orchestrator wired against the service-role client.
    const deps = buildRunMatchJobDeps(db);
    const result = await runMatchJob(
      { jobQueryId: decomposed.query_id, topN: 10, triggeredBy: appUserId },
      deps,
    );

    expect(result.run_id).toBeTypeOf('string');
    expect(result.candidates_evaluated).toBe(15); // 5 strong + 10 medium; 5 excluded by pre-filter
    expect(result.top).toHaveLength(10);

    // 3. match_runs row is closed.
    const { data: runRow, error: runErr } = await db
      .from('match_runs')
      .select('id, status, finished_at, candidates_evaluated, triggered_by, diagnostics')
      .eq('id', result.run_id)
      .single();
    expect(runErr).toBeNull();
    expect(runRow!.status).toBe('completed');
    expect(runRow!.finished_at).not.toBeNull();
    expect(runRow!.candidates_evaluated).toBe(15);
    expect(runRow!.triggered_by).toBe(appUserId);

    // 4. match_results has 15 rows with contiguous ranks 1..15.
    const { data: rows, error: rowsErr } = await db
      .from('match_results')
      .select('candidate_id, total_score, must_have_gate, rank, breakdown_json')
      .eq('match_run_id', result.run_id)
      .order('rank', { ascending: true });
    expect(rowsErr).toBeNull();
    expect(rows).toHaveLength(15);
    const ranked = rows ?? [];
    const ranks = ranked.map((r) => r.rank as number);
    expect(ranks).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]);

    // 5. Scores are monotonically non-increasing by rank.
    for (let i = 1; i < ranked.length; i += 1) {
      const prev = ranked[i - 1]!.total_score as number;
      const curr = ranked[i]!.total_score as number;
      expect(curr).toBeLessThanOrEqual(prev);
    }

    // 6. Top-5 strong candidates beat the medium group (scores strictly
    //    higher). The top-5 set (unordered within ties) equals the
    //    `strongIds` set.
    const top5Ids = new Set(ranked.slice(0, 5).map((r) => r.candidate_id as string));
    expect(top5Ids).toEqual(strongIds);
    expect(ranked[4]!.total_score as number).toBeGreaterThan(ranked[5]!.total_score as number);

    // 7. No excluded candidate made it into results.
    for (const row of ranked) {
      expect(excludedIds.has(row.candidate_id as string)).toBe(false);
      expect(row.must_have_gate).toBe('passed'); // all 15 have both must-haves
    }

    // 8. API-style `top` slice matches DB rows 1..10 by candidate_id.
    const apiTopIds = result.top.map((s) => s.candidate_id);
    const dbTop10Ids = ranked.slice(0, 10).map((r) => r.candidate_id as string);
    expect(apiTopIds).toEqual(dbTop10Ids);

    // 9. breakdown_json round-trips with expected sub-objects.
    const firstBreakdown = ranked[0]!.breakdown_json as {
      breakdown: unknown[];
      language_match: unknown;
      seniority_match: unknown;
    };
    expect(firstBreakdown).toHaveProperty('breakdown');
    expect(firstBreakdown).toHaveProperty('language_match');
    expect(firstBreakdown).toHaveProperty('seniority_match');
    expect(Array.isArray(firstBreakdown.breakdown)).toBe(true);
  });

  it('a second run over the same job_query creates a new run_id (idempotent job query, new run)', async () => {
    await seedFixture(db);
    const rawJd = `Backend Senior con 3+ años de ${SKILL_NODEJS_RAW} y 3+ años de ${SKILL_POSTGRES_RAW}.`;
    const decomposed = await decomposeJobQuery(rawJd, buildDecomposeDeps(db, appUserId));

    const deps = buildRunMatchJobDeps(db);
    const first = await runMatchJob(
      { jobQueryId: decomposed.query_id, topN: 5, triggeredBy: appUserId },
      deps,
    );
    const second = await runMatchJob(
      { jobQueryId: decomposed.query_id, topN: 5, triggeredBy: appUserId },
      deps,
    );

    expect(second.run_id).not.toBe(first.run_id);
    const { count } = await db
      .from('match_runs')
      .select('id', { count: 'exact', head: true })
      .eq('job_query_id', decomposed.query_id);
    expect(count).toBe(2);
  });
});
