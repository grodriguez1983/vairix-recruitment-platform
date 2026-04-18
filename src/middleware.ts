/**
 * Supabase session refresh middleware.
 *
 * Runs on every request (minus static assets) so the short-lived
 * access token gets rotated before it expires. This keeps
 * Server Components in sync without them having to set cookies
 * themselves (which Next.js disallows in pure SC context).
 *
 * Route protection (redirecting unauthenticated users to /login)
 * will be handled in F1-009c via `requireAuth()` on protected
 * routes, not here. Middleware here is JUST about session refresh.
 */
import { createServerClient, type CookieOptions } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';

import { supabasePublishableKey, supabaseUrl } from './lib/supabase/env';

export async function middleware(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request });

  const supabase = createServerClient(supabaseUrl(), supabasePublishableKey(), {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet: { name: string; value: string; options: CookieOptions }[]) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Triggers an internal refresh if the access token is close to
  // expiring. The returned user object is unused here — we only care
  // about the side-effect on the cookie store.
  await supabase.auth.getUser();

  return response;
}

export const config = {
  matcher: [
    /*
     * Skip Next.js internals and common static files. Match
     * everything else so session refresh covers all app routes,
     * including Server Actions and API routes.
     */
    '/((?!_next/static|_next/image|favicon.ico|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
};
