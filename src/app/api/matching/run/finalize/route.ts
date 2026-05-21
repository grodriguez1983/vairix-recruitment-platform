/**
 * POST /api/matching/run/finalize — ADR-034 §3, closer of the
 * FE-driven chunked matching pipeline.
 *
 * The FE calls this once after the /process-chunk loop ends, passing
 * back the `excluded` list it cached from /start. Backend:
 *   - Loads top-N by `total_score desc` (no global re-rank; rank
 *     stays chunk-local per migration 004 / Option 1).
 *   - Loads gate-failed candidates, merges with `excluded`, calls
 *     `rescueFailedCandidates` (errors swallowed — ADR-016 §1).
 *   - `completeMatchRun(status='completed')`.
 *
 * Contract:
 *   - Body: `{ run_id: uuid, top_n: int (1..100, default 10),
 *              excluded: PreFilterExcludedCandidate[] }`
 *   - Response: `{ candidates_evaluated, top, rescues_inserted? }`
 *   - 404 if the run does not exist.
 *   - 409 if the run is in a terminal status — FE shouldn't retry.
 *   - 500 for unexpected failures; the run stays `running` so the
 *     FE can retry /finalize.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { buildFinalizeMatchRunDeps } from '@/lib/matching/db-deps';
import { finalizeMatchRun } from '@/lib/matching/finalize-match-run';
import { createClient } from '@/lib/supabase/server';

export const finalizeMatchRequestSchema = z
  .object({
    run_id: z.string().uuid(),
    top_n: z.number().int().positive().max(100).default(10),
    excluded: z
      .array(
        z
          .object({
            candidate_id: z.string().uuid(),
            missing_must_have_skill_ids: z.array(z.string().uuid()),
          })
          .strip(),
      )
      .default([]),
  })
  .strip();

export type FinalizeMatchRequest = z.infer<typeof finalizeMatchRequestSchema>;

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

  let parsed: FinalizeMatchRequest;
  try {
    parsed = finalizeMatchRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const supabase = createClient();
  const deps = buildFinalizeMatchRunDeps(supabase);

  const tStart = Date.now();
  console.error(
    `[match] POST /api/matching/run/finalize: start run_id=${parsed.run_id} top_n=${parsed.top_n} excluded=${parsed.excluded.length}`,
  );
  try {
    const result = await finalizeMatchRun(
      { runId: parsed.run_id, topN: parsed.top_n, excluded: parsed.excluded },
      deps,
    );
    console.error(
      `[match] POST /api/matching/run/finalize: ok ${Date.now() - tStart}ms evaluated=${result.candidates_evaluated} top=${result.top.length} rescues=${result.rescues_inserted ?? 'n/a'}`,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[match] POST /api/matching/run/finalize: FAILED ${Date.now() - tStart}ms message=${message}`,
    );
    if (/match_run not found/i.test(message)) {
      return NextResponse.json({ error: 'match_run_not_found' }, { status: 404 });
    }
    if (/is not running/i.test(message)) {
      return NextResponse.json({ error: 'match_run_not_running', message }, { status: 409 });
    }
    return NextResponse.json({ error: 'finalize_match_run_failed', message }, { status: 500 });
  }
}
