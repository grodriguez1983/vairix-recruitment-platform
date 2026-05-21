/**
 * POST /api/matching/run/process-chunk — ADR-034 §2, workhorse of
 * the FE-driven chunked matching pipeline.
 *
 * The FE calls this N times, one per slice of the `included` list it
 * received from `/start`. Each call:
 *   - loads the run (must be `running`),
 *   - loads aggregates for the chunk,
 *   - ranks them (chunk-local),
 *   - persists results with chunk-local rank,
 *   - bumps `processed_count` + `last_progress_at`.
 *
 * Contract:
 *   - Body: `{ run_id: uuid, candidate_ids: uuid[] (max 500) }`
 *   - Chunk size cap is 500 — matches the insert chunk size in
 *     db-deps (ADR-032) and keeps a single /process-chunk under the
 *     PostgREST ~1 MB body cap.
 *   - Response: `{ processed_count, total, new_results }` where
 *     `total = match_runs.expected_count` and `processed_count` is
 *     the post-bump value (authoritative).
 *   - 404 if the run does not exist.
 *   - 409 if the run is in a terminal status (completed/failed/
 *     abandoned) — the FE shouldn't retry.
 *   - 500 for unexpected failures; the run stays `running` so the
 *     FE can retry the chunk if it chooses.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { buildProcessMatchChunkDeps } from '@/lib/matching/db-deps';
import { processMatchChunk } from '@/lib/matching/process-match-chunk';
import { createClient } from '@/lib/supabase/server';

export const processMatchChunkRequestSchema = z
  .object({
    run_id: z.string().uuid(),
    candidate_ids: z.array(z.string().uuid()).max(500),
  })
  .strip();

export type ProcessMatchChunkRequest = z.infer<typeof processMatchChunkRequestSchema>;

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

  let parsed: ProcessMatchChunkRequest;
  try {
    parsed = processMatchChunkRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  const supabase = createClient();
  const deps = buildProcessMatchChunkDeps(supabase);

  const tStart = Date.now();
  console.error(
    `[match] POST /api/matching/run/process-chunk: start run_id=${parsed.run_id} chunk=${parsed.candidate_ids.length}`,
  );
  try {
    const result = await processMatchChunk(
      { runId: parsed.run_id, candidateIds: parsed.candidate_ids },
      deps,
    );
    console.error(
      `[match] POST /api/matching/run/process-chunk: ok ${Date.now() - tStart}ms processed=${result.processed_count}/${result.total ?? '?'} new=${result.new_results.length}`,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    console.error(
      `[match] POST /api/matching/run/process-chunk: FAILED ${Date.now() - tStart}ms message=${message}`,
    );
    if (/match_run not found/i.test(message)) {
      return NextResponse.json({ error: 'match_run_not_found' }, { status: 404 });
    }
    if (/is not running/i.test(message)) {
      return NextResponse.json({ error: 'match_run_not_running', message }, { status: 409 });
    }
    return NextResponse.json({ error: 'process_chunk_failed', message }, { status: 500 });
  }
}
