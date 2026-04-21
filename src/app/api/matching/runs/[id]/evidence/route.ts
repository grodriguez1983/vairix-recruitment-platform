/**
 * GET /api/matching/runs/:id/evidence?candidate_id=... — ADR-016 §2.
 *
 * Returns the per-requirement evidence snippets for a single
 * candidate in the context of a given run's job_query. RLS
 * (migrations 20260420000007 + 20260420000005) scopes the run +
 * job_query reads; files.parsed_text is readable by any authed
 * recruiter via `files_read_all_authenticated`. The FTS RPC is
 * `security invoker`, so RLS still applies.
 *
 * Derived read — never persisted (ADR-016 §2). Caller is expected
 * to call this lazily when a breakdown drawer expands.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { getAuthUser } from '@/lib/auth/require';
import {
  fetchEvidenceSnippets,
  type ComplementarySignalsDeps,
  type FtsHit,
} from '@/lib/rag/complementary-signals';
import type { ResolvedDecomposition } from '@/lib/rag/decomposition/resolve-requirements';
import { createClient } from '@/lib/supabase/server';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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

  const candidateId = new URL(request.url).searchParams.get('candidate_id');
  if (!candidateId || !UUID_RE.test(candidateId)) {
    return NextResponse.json({ error: 'invalid_candidate_id' }, { status: 400 });
  }

  const supabase = createClient();

  const { data: run, error: runErr } = await supabase
    .from('match_runs')
    .select('id, job_query_id')
    .eq('id', params.id)
    .maybeSingle();
  if (runErr) {
    return NextResponse.json({ error: 'db_error', message: runErr.message }, { status: 500 });
  }
  if (!run) {
    return NextResponse.json({ error: 'match_run_not_found' }, { status: 404 });
  }

  const { data: jq, error: jqErr } = await supabase
    .from('job_queries')
    .select('resolved_json')
    .eq('id', run.job_query_id as string)
    .maybeSingle();
  if (jqErr) {
    return NextResponse.json({ error: 'db_error', message: jqErr.message }, { status: 500 });
  }
  if (!jq) {
    return NextResponse.json({ error: 'job_query_not_found' }, { status: 404 });
  }

  const resolved = jq.resolved_json as unknown as ResolvedDecomposition | null;
  const skillIds =
    resolved?.requirements
      ?.map((r) => r.skill_id)
      .filter((id): id is string => typeof id === 'string') ?? [];

  if (skillIds.length === 0) {
    return NextResponse.json({ candidate_id: candidateId, snippets: {} }, { status: 200 });
  }

  const { data: skills, error: skillErr } = await supabase
    .from('skills_catalog')
    .select('id, slug')
    .in('id', skillIds);
  if (skillErr) {
    return NextResponse.json({ error: 'db_error', message: skillErr.message }, { status: 500 });
  }
  const slugs = (skills ?? [])
    .map((s) => s.slug as string | null)
    .filter((s): s is string => typeof s === 'string');

  const deps: ComplementarySignalsDeps = {
    queryFts: async ({ candidateIds, skillSlugs }) => {
      if (candidateIds.length === 0 || skillSlugs.length === 0) return [];
      const { data, error } = await supabase.rpc('match_rescue_fts_search', {
        candidate_ids_in: candidateIds,
        skill_slugs_in: skillSlugs,
      });
      if (error) throw new Error(`match_rescue_fts_search: ${error.message}`);
      const rows = (data ?? []) as Array<{
        candidate_id: string;
        skill_slug: string;
        ts_rank: number | string;
        snippet: string;
      }>;
      return rows.map(
        (r): FtsHit => ({
          candidate_id: r.candidate_id,
          skill_slug: r.skill_slug,
          ts_rank: Number(r.ts_rank),
          snippet: r.snippet,
        }),
      );
    },
  };

  try {
    const result = await fetchEvidenceSnippets(
      { candidate_id: candidateId, skill_slugs: slugs },
      deps,
    );
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: 'evidence_failed', message }, { status: 500 });
  }
}
