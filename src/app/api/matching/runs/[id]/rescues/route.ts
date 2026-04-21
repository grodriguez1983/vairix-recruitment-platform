/**
 * GET /api/matching/runs/:id/rescues — F4-008 bis (ADR-016 §1).
 *
 * Returns the recall-fallback bucket for a run: candidates whose
 * must-have gate failed but whose parsed CV text shows FTS evidence
 * of the missing skills above `FTS_RESCUE_THRESHOLD`.
 *
 * Auth required; RLS (migration `20260421000005`) scopes visibility
 * to the recruiter who triggered the parent run (or admin). The run
 * existence check here returns 404 when RLS hides the row.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { getAuthUser } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const auth = await getAuthUser();
  if (!auth) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  if (!UUID_RE.test(params.id)) {
    return NextResponse.json({ error: 'invalid_run_id' }, { status: 400 });
  }

  const supabase = createClient();
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

  const { data, error } = await supabase
    .from('match_rescues')
    .select('candidate_id, missing_skills, fts_snippets, fts_max_rank, created_at')
    .eq('match_run_id', params.id)
    .order('fts_max_rank', { ascending: false });
  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }

  return NextResponse.json(
    {
      run_id: params.id,
      rescues: data ?? [],
    },
    { status: 200 },
  );
}
