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

  return {
    adminEmail: E2E_ADMIN_EMAIL,
    adminAuthUserId,
    candidateIds: cands.map((c) => c.id),
    jobId: jobRow.id,
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
