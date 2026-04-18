/**
 * POST /api/search/hybrid — structured + semantic search (UC-01, F3-003).
 *
 * Accepts both structured filters and an optional query string. The
 * structured filters gate the candidate set first; the query reranks
 * what survives. With no query, returns the unranked id set; with no
 * filter, degenerates to pure semantic.
 *
 * Trust boundary mirrors /api/search/semantic: Zod validates, auth
 * blocks anon, RLS enforces visibility via an RLS-scoped Supabase
 * client. `OPENAI_API_KEY` is only required when the query is non-empty
 * — structured-only calls short-circuit before touching the provider.
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import { resolveEmbeddingProvider } from '@/lib/embeddings/provider-factory';
import { hybridSearchCandidates } from '@/lib/rag/hybrid-search';
import { type EmbeddingSourceType } from '@/lib/rag/semantic-search';
import { createClient } from '@/lib/supabase/server';

const SOURCE_TYPES = [
  'profile',
  'notes',
  'cv',
  'evaluation',
] as const satisfies readonly EmbeddingSourceType[];
const APPLICATION_STATUS = ['active', 'rejected', 'hired', 'withdrawn'] as const;

function emptyToNull(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

const requestSchema = z.object({
  query: z.preprocess(emptyToNull, z.string().max(2000).nullable().default(null)),
  filters: z
    .object({
      status: z.preprocess(emptyToNull, z.enum(APPLICATION_STATUS).nullable().default(null)),
      rejectedAfter: z.preprocess(
        emptyToNull,
        z.string().datetime({ offset: true }).nullable().default(null),
      ),
      rejectedBefore: z.preprocess(
        emptyToNull,
        z.string().datetime({ offset: true }).nullable().default(null),
      ),
      jobId: z.preprocess(emptyToNull, z.string().uuid().nullable().default(null)),
    })
    .default({
      status: null,
      rejectedAfter: null,
      rejectedBefore: null,
      jobId: null,
    }),
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
    parsed = requestSchema.parse(body);
  } catch (err) {
    if (err instanceof ZodError) {
      return NextResponse.json({ error: 'invalid_request', issues: err.issues }, { status: 400 });
    }
    throw err;
  }

  // Only resolve the provider when we'll actually embed. Structured-only
  // calls should not fail with 503 just because OPENAI_API_KEY is unset.
  const needsProvider = parsed.query !== null && parsed.query.length > 0;
  let provider;
  if (needsProvider) {
    try {
      provider = resolveEmbeddingProvider();
    } catch (err) {
      const message = err instanceof Error ? err.message : 'provider unavailable';
      return NextResponse.json({ error: 'provider_unavailable', message }, { status: 503 });
    }
  } else {
    // Structured mode: pass a no-op provider — it's never called.
    provider = {
      model: 'unused',
      dim: 1536,
      embed: async () => {
        throw new Error('provider called in structured-only mode');
      },
    };
  }

  const supabase = createClient();
  const result = await hybridSearchCandidates(supabase, provider, {
    query: parsed.query,
    filters: parsed.filters,
    limit: parsed.limit,
    sourceTypes: parsed.sourceTypes,
  });

  return NextResponse.json(result, { status: 200 });
}
