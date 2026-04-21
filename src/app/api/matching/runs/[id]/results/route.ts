/**
 * GET /api/matching/runs/:id/results?offset=&limit= — F4-008 sub-D.
 *
 * Returns the paginated, breakdown-included results for a run,
 * ordered by `rank` asc. Auth required; RLS enforces ownership
 * (migration `20260420000007_rls_match_runs_and_results`).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const resultsQuerySchema = z
  .object({
    offset: z.coerce.number().int().nonnegative().default(0),
    limit: z.coerce.number().int().positive().max(200).default(50),
  })
  .strip();

export type ResultsQuery = z.infer<typeof resultsQuerySchema>;

export async function GET(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const auth = await getAuthUser();
  if (!auth) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_run_id' }, { status: 400 });
  }

  let parsed: ResultsQuery;
  try {
    const url = new URL(request.url);
    parsed = resultsQuerySchema.parse(Object.fromEntries(url.searchParams));
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_query', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const supabase = createClient();
  // Verify the run exists + is visible under RLS before paginating
  // results. A missing run here means "not found or not yours".
  const { data: run, error: runErr } = await supabase
    .from('match_runs')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (runErr) {
    return NextResponse.json({ error: 'db_error', message: runErr.message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: 'match_run_not_found' }, { status: 404 });
  }

  const from = parsed.offset;
  const to = parsed.offset + parsed.limit - 1;
  const { data, error, count } = await supabase
    .from('match_results')
    .select('candidate_id, total_score, must_have_gate, rank, breakdown_json', {
      count: 'exact',
    })
    .eq('match_run_id', params.id)
    .order('rank', { ascending: true })
    .range(from, to);
  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      run_id: params.id,
      offset: parsed.offset,
      limit: parsed.limit,
      total: count ?? data?.length ?? 0,
      results: data ?? [],
    },
    { status: 200 },
  );
}
