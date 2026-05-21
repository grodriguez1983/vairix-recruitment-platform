/**
 * POST /api/matching/run/start — ADR-034 §1, first endpoint of the
 * FE-driven chunked matching pipeline.
 *
 * Trust boundary (mirrors POST /api/matching/run):
 *   1. Authenticate caller (401 otherwise).
 *   2. Validate request shape via Zod (400 on bad input).
 *   3. Resolve `app_users.id` via `current_app_user_id` for
 *      `triggered_by` (same RLS posture as the legacy route).
 *   4. Call `startMatchRun`, which opens a `match_run`, runs
 *      preFilter and stamps `expected_count`. On failure the
 *      service has already called `failMatchRun` if a run existed.
 *   5. Return `{ run_id, included, excluded, total, tenant_id }` —
 *      the plan the FE consumes to drive `/process-chunk` calls.
 *
 * Contract:
 *   - Body: `{ job_query_id: uuid }`
 *   - `top_n` is intentionally NOT accepted here — it belongs to
 *     /finalize, which is the endpoint that returns the final
 *     top-N slice to the FE. Keeping each endpoint's input minimal
 *     avoids parameter drift between sibling routes.
 *   - Unknown top-level keys are stripped, not errored, matching
 *     the posture of `runMatchRequestSchema` in the legacy
 *     /api/matching/run.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { buildStartMatchRunDeps } from '@/lib/matching/db-deps';
import { startMatchRun } from '@/lib/matching/start-match-run';
import { createClient } from '@/lib/supabase/server';

export const startMatchRequestSchema = z
  .object({
    job_query_id: z.string().uuid(),
  })
  .strip();

export type StartMatchRequest = z.infer<typeof startMatchRequestSchema>;

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

  let parsed: StartMatchRequest;
  try {
    parsed = startMatchRequestSchema.parse(body);
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

  const deps = buildStartMatchRunDeps(supabase);

  const tStart = Date.now();
  console.error(`[match] POST /api/matching/run/start: start job_query_id=${parsed.job_query_id}`);
  try {
    const result = await startMatchRun(
      { jobQueryId: parsed.job_query_id, triggeredBy: appUserId },
      deps,
    );
    console.error(
      `[match] POST /api/matching/run/start: ok ${Date.now() - tStart}ms run_id=${result.run_id} total=${result.total}`,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[match] POST /api/matching/run/start: FAILED ${Date.now() - tStart}ms message=${message}`,
    );
    if (/job_query not found/i.test(message)) {
      return NextResponse.json({ error: 'job_query_not_found' }, { status: 404 });
    }
    return NextResponse.json({ error: 'start_match_run_failed', message }, { status: 500 });
  }
}
