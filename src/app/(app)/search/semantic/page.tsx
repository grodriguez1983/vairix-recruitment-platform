/**
 * `/search/semantic` — pure semantic candidate search UI (UC-02, F3-002).
 *
 * Server-rendered: the form submits via GET so the URL is shareable
 * and the result page is just a re-render with `?q=...`. Calls the
 * underlying service directly with an RLS-scoped client (no extra
 * round trip through `/api/search/semantic` from the server).
 *
 * Renders ranked cards with a relevance score badge plus the source
 * types that contributed to the match (profile/notes/cv/evaluation).
 */
import Link from 'next/link';

import { requireAuth } from '@/lib/auth/require';
import { resolveEmbeddingProvider } from '@/lib/embeddings/provider-factory';
import {
  dedupeByCandidate,
  semanticSearchCandidates,
  type EmbeddingSourceType,
  type SemanticSearchCandidateMatch,
} from '@/lib/rag/semantic-search';
import { hydrateCandidatesByIds } from '@/lib/search/hydrate';
import { MAX_QUERY_LENGTH, parseQuery } from '@/lib/search/search-params';
import { createClient } from '@/lib/supabase/server';

import { CandidateCard } from '../../candidates/candidate-card';

export const metadata = {
  title: 'Semantic search — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

const RESULT_LIMIT = 30;

interface PageProps {
  searchParams: { q?: string | string[] };
}

function formatScore(score: number): string {
  return score.toFixed(3);
}

function sourceBadge(source: EmbeddingSourceType): string {
  switch (source) {
    case 'profile':
      return 'profile';
    case 'notes':
      return 'notes';
    case 'cv':
      return 'cv';
    case 'evaluation':
      return 'eval';
  }
}

export default async function SemanticSearchPage({
  searchParams,
}: PageProps): Promise<JSX.Element> {
  await requireAuth();

  const q = parseQuery(searchParams.q);
  const supabase = createClient();

  let matches: SemanticSearchCandidateMatch[] = [];
  let hydrated: Awaited<ReturnType<typeof hydrateCandidatesByIds>> = [];
  let providerError: string | null = null;

  if (q.length > 0) {
    try {
      const provider = resolveEmbeddingProvider();
      const hits = await semanticSearchCandidates(supabase, provider, {
        query: q,
        limit: RESULT_LIMIT,
      });
      matches = dedupeByCandidate(hits);
      hydrated = await hydrateCandidatesByIds(
        supabase,
        matches.map((m) => m.candidateId),
      );
    } catch (err) {
      providerError = err instanceof Error ? err.message : String(err);
    }
  }

  const matchByCandidate = new Map(matches.map((m) => [m.candidateId, m] as const));

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Semantic search
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Free-text query against the candidate corpus (profile, notes, CV, evaluations). Hybrid
          mode with structured filters lives at{' '}
          <Link href="/search/hybrid" className="text-accent hover:underline">
            /search/hybrid
          </Link>
          .
        </p>
      </header>

      <form method="get" className="mb-6 flex gap-2">
        <input
          name="q"
          type="search"
          defaultValue={q}
          maxLength={MAX_QUERY_LENGTH}
          placeholder="e.g. backend engineer with kafka and aws experience"
          className="flex-1 rounded-md border border-border bg-surface px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
        <button
          type="submit"
          className="rounded-md border border-border bg-bg px-4 py-2 font-mono text-xs uppercase tracking-wider text-text-primary hover:bg-surface"
        >
          search
        </button>
      </form>

      {providerError ? (
        <section className="rounded-lg border border-danger/40 bg-danger/5 p-4">
          <p className="font-mono text-xs text-danger">search failed: {providerError}</p>
        </section>
      ) : q.length === 0 ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            Type a query to retrieve the closest candidates by embedding similarity.
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
                <div className="flex items-center gap-2 px-1 font-mono text-[10px] uppercase tracking-wider text-text-muted">
                  <span className="rounded bg-bg px-1.5 py-0.5 text-text-primary">
                    score {match ? formatScore(match.bestScore) : '—'}
                  </span>
                  {match?.matchedSources.map((s) => (
                    <span key={s} className="rounded bg-bg px-1.5 py-0.5 text-text-muted">
                      {sourceBadge(s)}
                    </span>
                  ))}
                </div>
                <CandidateCard candidate={c} />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
