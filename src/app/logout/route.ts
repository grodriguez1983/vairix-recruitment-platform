/**
 * Logout endpoint. POST-only on purpose: GET logout via <a href>
 * can be triggered by a malicious site prefetching a link, which
 * would be a CSRF-ish logout attack. A form POST from our own UI
 * is fine.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const supabase = createClient();
  await supabase.auth.signOut();
  return NextResponse.redirect(new URL('/login', request.url), { status: 303 });
}
