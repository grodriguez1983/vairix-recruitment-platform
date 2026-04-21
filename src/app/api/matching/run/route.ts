/**
 * POST /api/matching/run — UC-11 execution entry point (F4-008).
 *
 * Trust boundary:
 *   1. Authenticate the caller (401 otherwise).
 *   2. Validate the request shape via Zod (400 on bad input).
 *   3. Resolve `app_users.id` via `current_app_user_id` RPC (matches
 *      the RLS invariant on `match_runs.triggered_by` enforced by
 *      ADR-017's `match_results_insert_own_run_or_admin` policy).
 *   4. Build `RunMatchJobDeps` against the RLS-scoped Supabase
 *      client — no service role (CLAUDE.md #4). The recruiter
 *      inserts their own `match_runs` + `match_results` under RLS.
 *   5. Call `runMatchJob` and return `{ run_id, candidates_evaluated,
 *      top }`. Top-N is the inline slice; full breakdown lives at
 *      `/api/matching/runs/:id/results` (paginated, out of scope in
 *      this slice).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { buildRunMatchJobDeps } from '@/lib/matching/db-deps';
import { runMatchJob } from '@/lib/matching/run-match-job';
import { createClient } from '@/lib/supabase/server';

export const runMatchRequestSchema = z
  .object({
    job_query_id: z.string().uuid(),
    top_n: z.number().int().positive().max(100).default(10),
  })
  .strip();

export type RunMatchRequest = z.infer<typeof runMatchRequestSchema>;

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

  let parsed: RunMatchRequest;
  try {
    parsed = runMatchRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const supabase = createClient();
  const { data: appUserId, error: rpcErr } = await supabase.rpc('current_app_user_id');
  if (rpcErr || typeof appUserId !== 'string') {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }

  const deps = buildRunMatchJobDeps(supabase);

  try {
    const result = await runMatchJob(
      {
        jobQueryId: parsed.job_query_id,
        topN: parsed.top_n,
        triggeredBy: appUserId,
      },
      deps,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    if (/job_query not found/i.test(message)) {
      return NextResponse.json({ error: 'job_query_not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'match_run_failed', message }, { status: 500 });
  }
}
