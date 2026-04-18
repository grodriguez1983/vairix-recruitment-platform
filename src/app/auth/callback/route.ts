/**
 * Auth callback handler for the magic link.
 *
 * Supabase sends the user here with `?code=<pkce-code>` appended.
 * We exchange that code for a session (which writes the auth
 * cookies via the server client) and then redirect to `next` or
 * `/` by default. On failure we bounce back to /login with a flag
 * so the page can surface a message.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = new URL(request.url);
  const code = url.searchParams.get('code');
  const next = url.searchParams.get('next') ?? '/';

  if (!code) {
    return NextResponse.redirect(new URL('/login?error=missing_code', url.origin));
  }

  const supabase = createClient();
  const { error } = await supabase.auth.exchangeCodeForSession(code);
  if (error) {
    return NextResponse.redirect(new URL('/login?error=exchange_failed', url.origin));
  }

  return NextResponse.redirect(new URL(next, url.origin));
}
