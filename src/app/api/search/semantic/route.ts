/**
 * POST /api/search/semantic — pure semantic candidate search (UC-02).
 *
 * Validates the request body, runs the query string through the
 * embeddings provider, and executes `semantic_search_embeddings`
 * through an RLS-scoped Supabase client. The RPC's `security invoker`
 * combined with the embeddings RLS policies means recruiters and
 * admins can read all embeddings; anon callers get a 401 here first.
 *
 * Response: deduplicated `matches` (best score per candidate across
 * source types), sorted score DESC. Hydrating candidate details
 * (name, email, pitch) is left to a follow-up pass — this endpoint
 * returns only the ranking.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { resolveEmbeddingProvider } from '@/lib/embeddings/provider-factory';
import {
  dedupeByCandidate,
  semanticSearchCandidates,
  type EmbeddingSourceType,
} from '@/lib/rag/semantic-search';
import { createClient } from '@/lib/supabase/server';

const SOURCE_TYPES = [
  'profile',
  'notes',
  'cv',
  'evaluation',
] as const satisfies readonly EmbeddingSourceType[];

export const semanticSearchRequestSchema = z.object({
  query: z.string().trim().min(1).max(2000),
  limit: z.number().int().min(1).max(50).optional(),
  sourceTypes: z.array(z.enum(SOURCE_TYPES)).max(4).optional(),
});

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
    parsed = semanticSearchRequestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  let provider;
  try {
    provider = resolveEmbeddingProvider();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'provider unavailable';
    return NextResponse.json({ error: 'provider_unavailable', message }, { status: 503 });
  }

  const supabase = createClient();
  const hits = await semanticSearchCandidates(supabase, provider, {
    query: parsed.query,
    limit: parsed.limit,
    sourceTypes: parsed.sourceTypes,
  });
  const matches = dedupeByCandidate(hits);

  return NextResponse.json({ matches }, { status: 200 });
}
