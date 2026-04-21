/**
 * GET /api/matching/runs/:id — F4-008 sub-D. Returns the metadata
 * for a single run (status, started_at, finished_at, diagnostics,
 * candidates_evaluated, catalog_snapshot_at). RLS enforces
 * ownership.
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
  const { data, error } = await supabase
    .from('match_runs')
    .select(
      'id, job_query_id, tenant_id, triggered_by, started_at, finished_at, status, candidates_evaluated, diagnostics, catalog_snapshot_at',
    )
    .eq('id', params.id)
    .maybeSingle();
  if (error) {
    return NextResponse.json({ error: 'db_error', message: error.message }, { status: 500 });
  }
  if (!data) {
    return NextResponse.json({ error: 'match_run_not_found' }, { status: 404 });
  }

  return NextResponse.json(data, { status: 200 });
}
