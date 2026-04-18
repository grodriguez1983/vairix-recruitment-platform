/**
 * Supabase client for server components, server actions, and route
 * handlers. Uses Next.js `cookies()` so the JWT travels with the
 * request and RLS applies as the logged-in user.
 *
 * Setting cookies from a pure Server Component is disallowed by
 * Next.js; we swallow that error here because the middleware will
 * also refresh the session on the next request, keeping things in
 * sync. Server Actions and Route Handlers DO allow cookie writes,
 * so refresh-on-login there works immediately.
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import type { SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';

import { supabasePublishableKey, supabaseUrl } from './env';

export function createClient(): SupabaseClient {
  const cookieStore = cookies();
  return createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — writes are disallowed.
          // Middleware will refresh the session on the next request.
        }
      },
    },
  });
}
