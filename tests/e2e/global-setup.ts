/**
 * Global setup for Playwright e2e.
 *
 * Runs ONCE before the test suite:
 *   1. Seeds fixtures into local Supabase (admin user + candidates).
 *   2. Mints a session for the admin user via `verifyOtp` on an
 *      email OTP that the admin API generated, and writes that
 *      session into a Playwright `storageState` file as a cookie
 *      formatted exactly like `@supabase/ssr` would write it (cookie
 *      name `sb-<projectRef>-auth-token`, `base64-` prefix, base64url
 *      of JSON, chunked at 3180 URL-encoded chars).
 *
 * Rationale: the app is PKCE-only on `/auth/callback`, but the admin
 * `generateLink` returns an implicit-flow URL (hash tokens). We can't
 * round-trip through the callback. Instead we bypass the browser leg
 * entirely: verify the OTP server-side, encode the session the way
 * `@supabase/ssr` does, and hand the cookies to Playwright.
 *
 * This keeps every test starting already authenticated as an admin.
 */
import { createClient } from '@supabase/supabase-js';
import type { FullConfig } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

import { E2E_ADMIN_EMAIL, seedE2EFixtures, svcClient } from './seed';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_ANON_KEY =
  process.env.SUPABASE_TEST_ANON_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6ImFub24iLCJleHAiOjE5ODM4MTI5OTZ9.CRXP1A7WOeoJeXxjNni43kdQwgnWNReilDMblYTn_I0';

const MAX_CHUNK_SIZE = 3180;
const BASE64_PREFIX = 'base64-';

/**
 * Mirrors `createChunks` from `@supabase/ssr`: chunks a cookie value
 * at MAX_CHUNK_SIZE URL-encoded chars and names subsequent chunks
 * `<key>.0`, `<key>.1`, ... We only need the naming + length logic;
 * we don't need to preserve boundary robustness because base64url
 * output contains no percent-escapes and no unicode.
 */
function chunkCookieValue(key: string, value: string): { name: string; value: string }[] {
  const encoded = encodeURIComponent(value);
  if (encoded.length <= MAX_CHUNK_SIZE) return [{ name: key, value }];
  const chunks: string[] = [];
  let remaining = value;
  while (remaining.length > 0) {
    // Since base64url is ASCII, encodeURIComponent is a no-op on length
    // except for `+`/`/` which don't appear. So we can chunk by raw length.
    chunks.push(remaining.slice(0, MAX_CHUNK_SIZE));
    remaining = remaining.slice(MAX_CHUNK_SIZE);
  }
  return chunks.map((v, i) => ({ name: `${key}.${i}`, value: v }));
}

function cookieNameFor(url: string): string {
  // Mirrors supabase-js: `sb-${hostname.split('.')[0]}-auth-token`.
  const host = new URL(url).hostname;
  const ref = host.split('.')[0] ?? host;
  return `sb-${ref}-auth-token`;
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  await seedE2EFixtures();

  const project = config.projects[0];
  const baseURL = project?.use.baseURL;
  if (!baseURL) throw new Error('global-setup: baseURL is required on a project');

  const storagePath = resolve(process.cwd(), 'playwright/.auth/admin.json');
  mkdirSync(dirname(storagePath), { recursive: true });

  // 1. Admin generates an email OTP for the admin user. We don't use
  //    `action_link` (implicit flow); we use `email_otp` directly.
  const svc = svcClient();
  const { data: linkData, error: linkErr } = await svc.auth.admin.generateLink({
    type: 'magiclink',
    email: E2E_ADMIN_EMAIL,
    options: { redirectTo: `${baseURL}/auth/callback` },
  });
  if (linkErr || !linkData?.properties?.email_otp) {
    throw new Error(`global-setup: generateLink failed: ${linkErr?.message ?? 'no email_otp'}`);
  }
  const emailOtp = linkData.properties.email_otp;

  // 2. Anon client verifies the OTP server-side → returns a session.
  const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: otpData, error: otpErr } = await anon.auth.verifyOtp({
    email: E2E_ADMIN_EMAIL,
    token: emailOtp,
    type: 'email',
  });
  if (otpErr || !otpData.session) {
    throw new Error(`global-setup: verifyOtp failed: ${otpErr?.message ?? 'no session'}`);
  }
  const session = otpData.session;

  // 3. Encode the session exactly like @supabase/ssr does when writing
  //    the auth cookie: `base64-` prefix + base64url(JSON(session)).
  const sessionJson = JSON.stringify(session);
  const encoded = BASE64_PREFIX + Buffer.from(sessionJson, 'utf-8').toString('base64url');

  // The cookie lives on the APP's origin, but its *name* is derived
  // from the Supabase URL's hostname (see supabase-js default storage
  // key), so we compute the name from SUPABASE_URL and the domain
  // from baseURL.
  const appUrl = new URL(baseURL);
  const supabaseCookieName = cookieNameFor(SUPABASE_URL);

  const cookieParts = chunkCookieValue(supabaseCookieName, encoded);
  const expires = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; // 30d
  const cookies = cookieParts.map((p) => ({
    name: p.name,
    value: p.value,
    domain: appUrl.hostname,
    path: '/',
    expires,
    httpOnly: false,
    secure: false,
    sameSite: 'Lax' as const,
  }));

  const storageState = { cookies, origins: [] as unknown[] };
  writeFileSync(storagePath, JSON.stringify(storageState, null, 2), 'utf-8');
}
