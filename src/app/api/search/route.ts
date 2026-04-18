/**
 * POST /api/search — structured candidate search endpoint (UC-01).
 *
 * Trust boundary for the search service. Validates request body with
 * Zod, ensures the caller is authenticated (401 otherwise), and
 * delegates to `searchCandidates` with an RLS-scoped Supabase client.
 * Never uses the service role key — soft-delete and tenant filtering
 * are enforced by RLS based on the caller's JWT.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { requestToFilters, searchRequestSchema } from '@/lib/search/schema';
import { searchCandidates } from '@/lib/search/search';
import { createClient } from '@/lib/supabase/server';

export async function POST(request: NextRequest): Promise<NextResponse> {
  const auth = await getAuthUser();
  if (!auth) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  let parsed;
  try {
    parsed = searchRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const filters = requestToFilters(parsed);
  const supabase = createClient();
  const page = await searchCandidates(supabase, filters);

  return NextResponse.json(page, { status: 200 });
}
