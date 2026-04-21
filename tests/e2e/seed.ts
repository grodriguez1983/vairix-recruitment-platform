/**
 * Seeds the local Supabase stack with deterministic fixtures for
 * e2e smoke tests:
 *   - One admin auth.user + app_users row (email `e2e-admin@e2e.test`).
 *   - Three candidates with predictable names/pitches.
 *   - One job + one active application linking a candidate to it.
 *
 * Idempotent: re-running wipes prior e2e artifacts (identified by
 * the `@e2e.test` email suffix and the `e2e-*` teamtailor_id prefix)
 * and re-seeds. Safe to invoke from global-setup AND stand-alone via
 * `pnpm test:e2e:seed`.
 *
 * Uses the service role key because seeding auth.users + app_users
 * requires bypassing RLS. Never imported from application code.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

export const E2E_ADMIN_EMAIL = 'e2e-admin@e2e.test';
export const E2E_EMAIL_SUFFIX = '@e2e.test';
export const E2E_TT_ID_PREFIX = 'e2e-';

export function svcClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function wipeE2EArtifacts(svc: SupabaseClient): Promise<void> {
  // match_runs cascade to match_results; job_queries cascade to match_runs.
  // skill_aliases cascades with skills. candidate_extractions cascades to
  // candidate_experiences → experience_skills. Candidate deletion takes
  // care of all candidate_-scoped children.
  await svc.from('job_queries').delete().like('content_hash', `${E2E_TT_ID_PREFIX}%`);
  await svc.from('skills').delete().like('slug', `${E2E_TT_ID_PREFIX}%`);
  // Applications → candidates → jobs (children first, FK-safe).
  await svc.from('applications').delete().like('teamtailor_id', `${E2E_TT_ID_PREFIX}%`);
  await svc.from('candidates').delete().like('teamtailor_id', `${E2E_TT_ID_PREFIX}%`);
  await svc.from('jobs').delete().like('teamtailor_id', `${E2E_TT_ID_PREFIX}%`);
  // app_users referencing our test emails.
  await svc.from('app_users').delete().like('email', `%${E2E_EMAIL_SUFFIX}`);
  // auth.users with our email suffix.
  const { data: users } = await svc.auth.admin.listUsers({ page: 1, perPage: 200 });
  for (const u of users?.users ?? []) {
    if (u.email?.endsWith(E2E_EMAIL_SUFFIX)) {
      await svc.auth.admin.deleteUser(u.id);
    }
  }
}

export interface SeedOutcome {
  adminEmail: string;
  adminAuthUserId: string;
  candidateIds: string[];
  jobId: string;
  matchRunId: string;
  reactSkillId: string;
  uncatalogedExperienceSkillId: string;
}

export async function seedE2EFixtures(): Promise<SeedOutcome> {
  const svc = svcClient();
  await wipeE2EArtifacts(svc);

  // 1. Admin auth user.
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email: E2E_ADMIN_EMAIL,
    email_confirm: true,
  });
  if (authErr || !authData.user) {
    throw new Error(`seed admin auth failed: ${authErr?.message ?? 'no user'}`);
  }
  const adminAuthUserId = authData.user.id;

  // 2. Admin app_users row.
  const { error: appErr } = await svc.from('app_users').insert({
    auth_user_id: adminAuthUserId,
    email: E2E_ADMIN_EMAIL,
    role: 'admin',
  });
  if (appErr) throw new Error(`seed admin app_users failed: ${appErr.message}`);

  // 3. Candidates.
  const { data: cands, error: candErr } = await svc
    .from('candidates')
    .insert([
      {
        teamtailor_id: `${E2E_TT_ID_PREFIX}alice`,
        first_name: 'Alice',
        last_name: 'Lang',
        email: 'alice@example.com',
        pitch: 'Senior backend engineer with Go and Kubernetes experience.',
      },
      {
        teamtailor_id: `${E2E_TT_ID_PREFIX}bob`,
        first_name: 'Bob',
        last_name: 'Smith',
        email: 'bob@example.com',
        pitch: 'Frontend engineer focused on React and accessibility.',
      },
      {
        teamtailor_id: `${E2E_TT_ID_PREFIX}carla`,
        first_name: 'Carla',
        last_name: 'Ng',
        email: 'carla@example.com',
        pitch: 'Full-stack developer with Node, TypeScript, and Postgres.',
      },
    ])
    .select('id, teamtailor_id');
  if (candErr || !cands) throw new Error(`seed candidates failed: ${candErr?.message}`);

  // 4. One job.
  const { data: jobRow, error: jobErr } = await svc
    .from('jobs')
    .insert({
      teamtailor_id: `${E2E_TT_ID_PREFIX}job-backend`,
      title: 'Backend Engineer',
      status: 'open',
    })
    .select('id')
    .single();
  if (jobErr || !jobRow) throw new Error(`seed job failed: ${jobErr?.message}`);

  // 5. One active application for Alice on that job.
  const aliceId = cands.find((c) => c.teamtailor_id === `${E2E_TT_ID_PREFIX}alice`)?.id;
  if (!aliceId) throw new Error('seed: Alice not found');
  const { error: appInsErr } = await svc.from('applications').insert({
    teamtailor_id: `${E2E_TT_ID_PREFIX}app-alice-backend`,
    candidate_id: aliceId,
    job_id: jobRow.id,
    status: 'active',
    stage_name: 'Phone screen',
  });
  if (appInsErr) throw new Error(`seed application failed: ${appInsErr.message}`);

  // 6. Matching fixtures: one skill + one file + one extraction +
  //    experiences (one resolved, one uncataloged) + one completed run.
  const { data: appUser, error: appUserErr } = await svc
    .from('app_users')
    .select('id')
    .eq('email', E2E_ADMIN_EMAIL)
    .single();
  if (appUserErr || !appUser) throw new Error('seed: admin app_user not found');

  const { data: skill, error: skillErr } = await svc
    .from('skills')
    .insert({
      slug: `${E2E_TT_ID_PREFIX}react`,
      canonical_name: 'React',
      category: 'frontend',
    })
    .select('id')
    .single();
  if (skillErr || !skill) throw new Error(`seed skill failed: ${skillErr?.message}`);

  const { data: file, error: fileErr } = await svc
    .from('files')
    .insert({
      candidate_id: aliceId,
      kind: 'cv',
      storage_path: `${E2E_TT_ID_PREFIX}alice.pdf`,
      content_hash: `${E2E_TT_ID_PREFIX}alice-cv-hash`,
      file_type: 'application/pdf',
      file_size_bytes: 1024,
      parsed_text: 'Alice has been building React apps since 2018 and uses Zig for systems work.',
    })
    .select('id')
    .single();
  if (fileErr || !file) throw new Error(`seed file failed: ${fileErr?.message}`);

  const { data: extraction, error: extErr } = await svc
    .from('candidate_extractions')
    .insert({
      candidate_id: aliceId,
      file_id: file.id,
      source_variant: 'cv_primary',
      model: 'e2e-stub',
      prompt_version: 'v0',
      content_hash: `${E2E_TT_ID_PREFIX}alice-extraction`,
      raw_output: { experiences: [] },
    })
    .select('id')
    .single();
  if (extErr || !extraction) throw new Error(`seed extraction failed: ${extErr?.message}`);

  const { data: experience, error: expErr } = await svc
    .from('candidate_experiences')
    .insert({
      candidate_id: aliceId,
      extraction_id: extraction.id,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Acme',
      title: 'Senior Frontend Engineer',
      start_date: '2018-01-01',
      end_date: '2023-12-31',
      description: 'Built React apps. Zig on the side.',
    })
    .select('id')
    .single();
  if (expErr || !experience) throw new Error(`seed experience failed: ${expErr?.message}`);

  const { data: esRows, error: esErr } = await svc
    .from('experience_skills')
    .insert([
      {
        experience_id: experience.id,
        skill_raw: 'React',
        skill_id: skill.id,
        resolved_at: new Date().toISOString(),
      },
      {
        experience_id: experience.id,
        skill_raw: 'Zig',
        skill_id: null,
      },
    ])
    .select('id, skill_id');
  if (esErr || !esRows) throw new Error(`seed experience_skills failed: ${esErr?.message}`);
  const uncatalogedRow = esRows.find((r) => r.skill_id === null);
  if (!uncatalogedRow) throw new Error('seed: uncataloged experience_skill not found');

  const reactRequirement = {
    skill_raw: 'React',
    skill_id: skill.id,
    min_years: 3,
    max_years: null,
    must_have: true,
    evidence_snippet: 'React experience required',
    category: 'technical' as const,
    resolved_at: new Date().toISOString(),
  };
  const resolvedJson = {
    requirements: [reactRequirement],
    seniority: 'senior' as const,
    languages: [],
    notes: null,
  };
  const decomposedJson = {
    requirements: [reactRequirement],
    seniority: 'senior',
    languages: [],
    notes: null,
  };

  const { data: jobQuery, error: jqErr } = await svc
    .from('job_queries')
    .insert({
      created_by: appUser.id,
      raw_text: 'Looking for a Senior React engineer with 3+ years.',
      raw_text_retained: true,
      normalized_text: 'looking for a senior react engineer with 3+ years.',
      content_hash: `${E2E_TT_ID_PREFIX}jq-react`,
      model: 'e2e-stub',
      prompt_version: 'v0',
      decomposed_json: decomposedJson,
      resolved_json: resolvedJson,
      unresolved_skills: [],
    })
    .select('id')
    .single();
  if (jqErr || !jobQuery) throw new Error(`seed job_query failed: ${jqErr?.message}`);

  const startedAt = new Date().toISOString();
  const { data: run, error: runErr } = await svc
    .from('match_runs')
    .insert({
      job_query_id: jobQuery.id,
      triggered_by: appUser.id,
      started_at: startedAt,
      finished_at: startedAt,
      status: 'completed',
      candidates_evaluated: 1,
      catalog_snapshot_at: startedAt,
      diagnostics: null,
    })
    .select('id')
    .single();
  if (runErr || !run) throw new Error(`seed match_run failed: ${runErr?.message}`);

  const breakdownJson = {
    breakdown: [
      {
        requirement: reactRequirement,
        candidate_years: 5,
        years_ratio: 1,
        contribution: 100,
        status: 'match',
        evidence: [
          {
            experience_id: experience.id,
            company: 'Acme',
            date_range: '2018-01 / 2023-12',
          },
        ],
      },
    ],
    language_match: { required: 0, matched: 0 },
    seniority_match: 'match',
  };

  const { error: mrErr } = await svc.from('match_results').insert({
    match_run_id: run.id,
    candidate_id: aliceId,
    total_score: 100,
    must_have_gate: 'passed',
    rank: 1,
    breakdown_json: breakdownJson,
  });
  if (mrErr) throw new Error(`seed match_result failed: ${mrErr.message}`);

  return {
    adminEmail: E2E_ADMIN_EMAIL,
    adminAuthUserId,
    candidateIds: cands.map((c) => c.id),
    jobId: jobRow.id,
    matchRunId: run.id,
    reactSkillId: skill.id,
    uncatalogedExperienceSkillId: uncatalogedRow.id,
  };
}

async function main(): Promise<void> {
  const outcome = await seedE2EFixtures();
  // eslint-disable-next-line no-console
  console.log('[e2e:seed] ok', outcome);
}

// Only execute when invoked as a script (pnpm test:e2e:seed), not
// when imported from global-setup.
const invokedAsScript = process.argv[1]?.endsWith('seed.ts') === true;
if (invokedAsScript) {
  void main();
}
