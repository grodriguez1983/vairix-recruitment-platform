/**
 * Seed a first admin user.
 *
 * Usage:
 *   pnpm tsx src/scripts/seed-admin.ts <email> [fullName]
 *
 * Creates (or reuses) the auth.users row for `email` and then
 * upserts an app_users row with role='admin' linked to it. This is
 * the ONLY code path that should touch app_users with the secret
 * key — production admin management is done via the admin panel
 * (F2) or, if needed, by re-running this script.
 *
 * Requires env:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY   (BYPASSES RLS; do not expose)
 *
 * Exit codes:
 *   0 — success
 *   1 — usage error
 *   2 — missing env / config
 *   3 — Supabase admin API error
 *   4 — DB write error
 */
import { createClient } from '@supabase/supabase-js';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[seed-admin] missing env: ${name}`);
    process.exit(2);
  }
  return v;
}

async function findOrCreateAuthUser(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  admin: any,
  email: string,
): Promise<{ id: string; created: boolean }> {
  // The admin API doesn't provide lookup-by-email on v2; list and filter.
  const { data: listData, error: listErr } = await admin.auth.admin.listUsers({
    page: 1,
    perPage: 1000,
  });
  if (listErr) {
    console.error('[seed-admin] listUsers failed:', listErr.message);
    process.exit(3);
  }
  const existing = listData.users.find(
    (u: { email: string | null }) => (u.email ?? '').toLowerCase() === email.toLowerCase(),
  );
  if (existing) {
    return { id: existing.id, created: false };
  }
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (createErr || !created.user) {
    console.error('[seed-admin] createUser failed:', createErr?.message);
    process.exit(3);
  }
  return { id: created.user.id, created: true };
}

async function main(): Promise<void> {
  const email = process.argv[2];
  const fullName = process.argv[3] ?? null;
  if (!email) {
    console.error('[seed-admin] usage: pnpm tsx src/scripts/seed-admin.ts <email> [fullName]');
    process.exit(1);
  }

  const url = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const secret = requireEnv('SUPABASE_SECRET_KEY');

  const admin = createClient(url, secret, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { id: authUserId, created } = await findOrCreateAuthUser(admin, email);

  const { error: upsertErr } = await admin.from('app_users').upsert(
    {
      auth_user_id: authUserId,
      email,
      full_name: fullName,
      role: 'admin',
      deactivated_at: null,
    },
    { onConflict: 'auth_user_id' },
  );
  if (upsertErr) {
    console.error('[seed-admin] app_users upsert failed:', upsertErr.message);
    process.exit(4);
  }

  // eslint-disable-next-line no-console
  console.log(
    `[seed-admin] ok: ${email} (${created ? 'new auth user' : 'existing auth user'}) promoted to admin`,
  );
  process.exit(0);
}

void main();
