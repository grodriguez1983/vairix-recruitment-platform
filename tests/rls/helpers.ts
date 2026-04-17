/**
 * Test harness for Row Level Security policies.
 *
 * Usage pattern (see tests/rls/*.test.ts for concrete examples):
 *   1. `const admin = serviceClient()` — bypasses RLS, used for seeding.
 *   2. `const { client, appUserId, authUserId } = await makeRoleClient('admin')`
 *      — creates an anon + JWT-authenticated client whose session
 *      identifies as an admin app_user. RLS applies normally.
 *   3. Run operations, assert allow/deny.
 *   4. `await resetRlsState(admin)` at the end of each test.
 *
 * The local Supabase stack (`supabase start`) ships with well-known
 * defaults for JWT secret and API keys; we hardcode them here because
 * they are not secrets and are identical on every developer machine.
 * CI will override via env vars.
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { createHmac, randomUUID } from 'node:crypto';

// ────────────────────────────────────────────────────────────────
// Local Supabase well-known defaults (printed by `supabase start`)
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';
const JWT_SECRET =
  process.env.SUPABASE_TEST_JWT_SECRET ?? 'super-secret-jwt-token-with-at-least-32-characters-long';

export type AppRole = 'recruiter' | 'admin';

// ────────────────────────────────────────────────────────────────
// JWT signing (HS256). Native crypto, no external dep.
// ────────────────────────────────────────────────────────────────

function base64url(input: string | Buffer): string {
  return Buffer.from(input)
    .toString('base64')
    .replace(/=/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/**
 * Signs a Supabase-shaped JWT with the local JWT secret.
 * Claims match what Supabase Auth would emit for an authenticated user:
 *   - `sub`: auth_user_id (matches auth.users.id)
 *   - `role`: always 'authenticated' (the Postgres role, NOT the app role)
 *   - `aud`: 'authenticated'
 *   - `exp`: 1h from now
 *
 * The **app role** (recruiter/admin) is resolved at policy-check time
 * via `public.current_app_role()`, which reads `app_users.role` by
 * `auth.uid()`. This decouples RLS from JWT claim structure.
 */
export function signTestJwt(authUserId: string): string {
  const now = Math.floor(Date.now() / 1000);
  const header = base64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = base64url(
    JSON.stringify({
      sub: authUserId,
      role: 'authenticated',
      aud: 'authenticated',
      iat: now,
      exp: now + 3600,
      iss: 'supabase-demo',
    }),
  );
  const signingInput = `${header}.${payload}`;
  const signature = base64url(createHmac('sha256', JWT_SECRET).update(signingInput).digest());
  return `${signingInput}.${signature}`;
}

// ────────────────────────────────────────────────────────────────
// Clients
// ────────────────────────────────────────────────────────────────

/**
 * Returns a Supabase client using the service role key. Bypasses RLS.
 * Use only for test seeding and teardown, never for the operation
 * under test.
 */
export function serviceClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Returns a client that acts as an anonymous (unauthenticated) caller.
 * Useful for testing public policies / deny-by-default.
 */
export function anonClient(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

/**
 * Creates an authenticated client that identifies as an `app_user` with
 * the given role. Internally:
 *   1. Creates a row in `auth.users` via the admin API.
 *   2. Inserts the corresponding `app_users` row.
 *   3. Signs a JWT with `sub = authUserId`.
 *   4. Returns a client with that JWT pre-set.
 */
export async function makeRoleClient(role: AppRole): Promise<{
  client: SupabaseClient;
  authUserId: string;
  appUserId: string;
  email: string;
}> {
  const svc = serviceClient();
  const email = `test-${role}-${randomUUID()}@rls.test`;

  // 1. Create auth.users row via admin API
  const { data: authData, error: authErr } = await svc.auth.admin.createUser({
    email,
    password: randomUUID(), // unused, but required
    email_confirm: true,
  });
  if (authErr || !authData.user) {
    throw new Error(`seed auth.users failed: ${authErr?.message ?? 'no user'}`);
  }
  const authUserId = authData.user.id;

  // 2. Create matching app_users row (service role bypasses RLS)
  const { data: appData, error: appErr } = await svc
    .from('app_users')
    .insert({
      auth_user_id: authUserId,
      email,
      role,
    })
    .select('id')
    .single();
  if (appErr || !appData) {
    throw new Error(`seed app_users failed: ${appErr?.message ?? 'no row'}`);
  }

  // 3. Sign JWT and attach to a fresh anon client
  const token = signTestJwt(authUserId);
  const client = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });

  return { client, authUserId, appUserId: appData.id, email };
}

// ────────────────────────────────────────────────────────────────
// Cleanup
// ────────────────────────────────────────────────────────────────

/**
 * Wipes test artifacts created during a test. Uses service role.
 * Order matters: children before parents.
 *
 * Called in afterEach. Keep this conservative — only wipe tables we
 * actually write to from tests.
 */
export async function resetRlsState(svc: SupabaseClient): Promise<void> {
  // Use raw SQL for efficiency. neq is required because the API rejects
  // unconditional deletes by default.
  await svc.from('app_users').delete().neq('id', '00000000-0000-0000-0000-000000000000');

  // Delete auth users created by test runs (email suffix `@rls.test`).
  const { data: users } = await svc.auth.admin.listUsers();
  for (const u of users?.users ?? []) {
    if (u.email?.endsWith('@rls.test')) {
      await svc.auth.admin.deleteUser(u.id);
    }
  }
}
