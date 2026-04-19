/**
 * `/search/hybrid` — structured filters + semantic rerank UI (UC-01,
 * F3-003).
 *
 * Server-rendered like `/search/semantic`. Form submits via GET so
 * URLs are shareable. Three modes surface based on input:
 *   - structured + query → ranked subset of structured candidates
 *   - structured only    → unranked ids (no embedding call)
 *   - query only         → pure semantic
 *
 * Empty input renders the "tell me what to look for" pane.
 */
import Link from 'next/link';

import { requireAuth } from '@/lib/auth/require';
import { resolveEmbeddingProvider } from '@/lib/embeddings/provider-factory';
import { hybridSearchCandidates, type HybridSearchResult } from '@/lib/rag/hybrid-search';
import {
  type EmbeddingSourceType,
  type SemanticSearchCandidateMatch,
} from '@/lib/rag/semantic-search';
import { hydrateCandidatesByIds } from '@/lib/search/hydrate';
import {
  MAX_QUERY_LENGTH,
  parseDateInputToIso,
  parseQuery,
  parseStatus,
  parseUuid,
} from '@/lib/search/search-params';
import { createClient } from '@/lib/supabase/server';

import { CandidateCard } from '../../candidates/candidate-card';

export const metadata = {
  title: 'Hybrid search — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

const RESULT_LIMIT = 30;

interface PageProps {
  searchParams: {
    q?: string | string[];
    status?: string | string[];
    rejected_after?: string | string[];
    rejected_before?: string | string[];
    job_id?: string | string[];
  };
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

function sourceBadge(source: EmbeddingSourceType): string {
  return source === 'evaluation' ? 'eval' : source;
}

async function fetchJobOptions(
  db: ReturnType<typeof createClient>,
): Promise<ReadonlyArray<{ id: string; title: string }>> {
  const { data } = await db
    .from('jobs')
    .select('id, title')
    .order('title', { ascending: true })
    .limit(500);
  return (data ?? [])
    .filter((row): row is { id: string; title: string } => Boolean(row?.id && row?.title))
    .map((row) => ({ id: row.id, title: row.title }));
}

export default async function HybridSearchPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireAuth();
  const supabase = createClient();

  const q = parseQuery(searchParams.q);
  const status = parseStatus(searchParams.status);
  const rejectedAfter = parseDateInputToIso(searchParams.rejected_after);
  const rejectedBefore = parseDateInputToIso(searchParams.rejected_before);
  const jobId = parseUuid(searchParams.job_id);

  const filters = { status, rejectedAfter, rejectedBefore, jobId };
  const hasFilter =
    status !== null || rejectedAfter !== null || rejectedBefore !== null || jobId !== null;
  const hasQuery = q.length > 0;

  const jobs = await fetchJobOptions(supabase);

  let result: HybridSearchResult | null = null;
  let providerError: string | null = null;

  if (hasQuery || hasFilter) {
    try {
      // Provider only resolved when actually needed (mirrors API route).
      const provider = hasQuery
        ? resolveEmbeddingProvider()
        : {
            model: 'unused',
            dim: 1536,
            embed: async (): Promise<number[][]> => {
              throw new Error('provider called in structured-only mode');
            },
          };
      result = await hybridSearchCandidates(supabase, provider, {
        query: hasQuery ? q : null,
        filters,
        limit: RESULT_LIMIT,
      });
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }
  }

  const idsToHydrate = result
    ? result.matches.length > 0
      ? result.matches.map((m) => m.candidateId)
      : result.candidateIds.slice(0, RESULT_LIMIT)
    : [];

  const hydrated = await hydrateCandidatesByIds(supabase, idsToHydrate);
  const matchByCandidate: Map<string, SemanticSearchCandidateMatch> = result
    ? new Map(result.matches.map((m) => [m.candidateId, m] as const))
    : new Map();

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Hybrid search
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Combine structured filters (status, job, date) with a free-text query. Pure semantic mode
          lives at{' '}
          <Link href="/search/semantic" className="text-accent hover:underline">
            /search/semantic
          </Link>
          .
        </p>
      </header>

      <form
        method="get"
        className="mb-6 flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <input
          name="q"
          type="search"
          defaultValue={q}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="natural language query (optional if filters are set)"
          className="rounded-md border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <div className="grid gap-2 sm:grid-cols-4">
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            status
            <select
              name="status"
              defaultValue={status ?? ''}
              className="rounded border border-border bg-bg px-2 py-1 text-xs text-text-primary"
            >
              <option value="">any</option>
              <option value="active">active</option>
              <option value="rejected">rejected</option>
              <option value="hired">hired</option>
              <option value="withdrawn">withdrawn</option>
            </select>
          </label>
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            rejected after
            <input
              name="rejected_after"
              type="date"
              defaultValue={rejectedAfter?.slice(0, 10) ?? ''}
              className="rounded border border-border bg-bg px-2 py-1 text-xs text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            rejected before
            <input
              name="rejected_before"
              type="date"
              defaultValue={rejectedBefore?.slice(0, 10) ?? ''}
              className="rounded border border-border bg-bg px-2 py-1 text-xs text-text-primary"
            />
          </label>
          <label className="flex flex-col gap-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
            job
            <select
              name="job_id"
              defaultValue={jobId ?? ''}
              className="rounded border border-border bg-bg px-2 py-1 text-xs text-text-primary"
            >
              <option value="">any</option>
              {jobs.map((j) => (
                <option key={j.id} value={j.id}>
                  {j.title}
                </option>
              ))}
            </select>
          </label>
        </div>
        <div className="flex items-center justify-between">
          {result && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              mode {result.mode} · {hydrated.length} shown
            </span>
          )}
          <div className="ml-auto flex gap-2">
            <Link
              href="/search/hybrid"
              className="rounded-md border border-border bg-bg px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-primary"
            >
              reset
            </Link>
            <button
              type="submit"
              className="rounded-md border border-border bg-bg px-4 py-1 font-mono text-[10px] uppercase tracking-wider text-text-primary hover:bg-surface"
            >
              search
            </button>
          </div>
        </div>
      </form>

      {providerError ? (
        <section className="rounded-lg border border-danger/40 bg-danger/5 p-4">
          <p className="font-mono text-xs text-danger">search failed: {providerError}</p>
        </section>
      ) : !hasQuery && !hasFilter ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            Type a query, set a filter, or both. Filters narrow the candidate set; the query reranks
            what survives.
          </p>
        </section>
      ) : hydrated.length === 0 ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">No matches.</p>
        </section>
      ) : (
        <ul className="flex flex-col gap-3">
          {hydrated.map((c) => {
            const match = matchByCandidate.get(c.id);
            return (
              <li key={c.id} className="flex flex-col gap-1">
                {match && (
                  <div className="flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                    <span className="rounded bg-bg px-1.5 py-0.5 text-text-primary">
                      score {formatScore(match.bestScore)}
                    </span>
                    {match.matchedSources.map((s) => (
                      <span key={s} className="rounded bg-bg px-1.5 py-0.5 text-text-muted">
                        {sourceBadge(s)}
                      </span>
                    ))}
                  </div>
                )}
                <CandidateCard candidate={c} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
