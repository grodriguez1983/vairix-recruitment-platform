/**
 * POST /api/matching/decompose — UC-11 entry point (ADR-014 §3/§6).
 *
 * Trust boundary for the decomposition service. Flow:
 *   1. Authenticate the caller (401 otherwise) via `getAuthUser`.
 *   2. Parse the body + Zod schema (400 on malformed JSON or shape).
 *   3. Resolve `app_users.id` via `current_app_user_id` RPC (matches
 *      the RLS invariant on `job_queries.created_by`).
 *   4. Build `DecomposeJobQueryDeps` against the RLS-scoped Supabase
 *      client (no service role — recruiters R/W their own rows per
 *      20260420000005_rls_job_queries.sql).
 *   5. Call `decomposeJobQuery` and map `DecompositionError.code` to
 *      HTTP status:
 *        - empty_input          → 400
 *        - hallucinated_snippet → 422
 *        - schema_violation     → 502 (bad provider response)
 *        - provider_failure     → 502
 *
 * The OpenAI provider is created per-request; it is stateless and the
 * hot path is the cache hit (no provider call).
 */
import { NextResponse, type NextRequest } from 'next/server';
import { z, ZodError } from 'zod';

import { getAuthUser } from '@/lib/auth/require';
import {
  decomposeJobQuery,
  type DecomposeJobQueryDeps,
  type JobQueryInsertRow,
} from '@/lib/rag/decomposition/decompose-job-query';
import { DecompositionError } from '@/lib/rag/decomposition/errors';
import { createOpenAiDecompositionProvider } from '@/lib/rag/decomposition/providers/openai-decomposer';
import type { ResolvedDecomposition } from '@/lib/rag/decomposition/resolve-requirements';
import type { DecompositionResult } from '@/lib/rag/decomposition/types';
import { loadCatalogSnapshot } from '@/lib/skills/catalog-loader';
import { createClient } from '@/lib/supabase/server';

export const decomposeRequestSchema = z.object({
  rawText: z
    .string()
    .min(1, 'rawText must be non-empty')
    .max(20000, 'rawText must be ≤20000 chars')
    .refine((v) => v.trim().length > 0, 'rawText must contain non-whitespace characters'),
});

export type DecomposeRequest = z.infer<typeof decomposeRequestSchema>;

function errorToStatus(code: DecompositionError['code']): number {
  switch (code) {
    case 'empty_input':
      return 400;
    case 'hallucinated_snippet':
      return 422;
    case 'schema_violation':
    case 'provider_failure':
      return 502;
  }
}

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

  let parsed: DecomposeRequest;
  try {
    parsed = decomposeRequestSchema.parse(body);
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

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: 'openai_not_configured' }, { status: 503 });
  }
  const provider = createOpenAiDecompositionProvider({
    apiKey,
    model: process.env.OPENAI_DECOMPOSITION_MODEL ?? 'gpt-4o-mini',
  });

  const deps: DecomposeJobQueryDeps = {
    provider,
    loadCatalog: () => loadCatalogSnapshot(supabase),
    findByHash: async (hash) => {
      const { data, error } = await supabase
        .from('job_queries')
        .select('id, content_hash, decomposed_json, unresolved_skills')
        .eq('content_hash', hash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return null;
      return {
        id: data.id as string,
        content_hash: data.content_hash as string,
        decomposed_json: data.decomposed_json as DecompositionResult,
        unresolved_skills: (data.unresolved_skills as string[]) ?? [],
      };
    },
    insertJobQuery: async (row: JobQueryInsertRow) => {
      const { data, error } = await supabase
        .from('job_queries')
        .insert({
          content_hash: row.content_hash,
          raw_text: row.raw_text,
          normalized_text: row.normalized_text,
          model: row.model,
          prompt_version: row.prompt_version,
          decomposed_json: row.decomposed_json,
          resolved_json: row.resolved_json,
          unresolved_skills: row.unresolved_skills,
          created_by: row.created_by,
          tenant_id: row.tenant_id,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'insert failed');
      return { id: data.id as string };
    },
    updateResolved: async (id, resolved: ResolvedDecomposition, unresolved) => {
      const { error } = await supabase
        .from('job_queries')
        .update({
          resolved_json: resolved,
          unresolved_skills: unresolved,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    createdBy: appUserId,
    tenantId: null,
  };

  try {
    const result = await decomposeJobQuery(parsed.rawText, deps);
    return NextResponse.json(result, { status: 200 });
  } catch (e) {
    if (e instanceof DecompositionError) {
      return NextResponse.json(
        { error: e.code, message: e.message },
        { status: errorToStatus(e.code) },
      );
    }
    throw e;
  }
}
