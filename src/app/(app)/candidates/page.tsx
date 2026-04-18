/**
 * `/candidates` — structured candidate search (UC-01 part 1).
 *
 * Server component: reads `?q=` and `?page=` from the URL and calls
 * `searchCandidates` directly with an RLS-scoped server client.
 * Soft-delete filtering + tenant scoping are enforced by RLS, not by
 * this page. The semantic half of UC-01 (embeddings) lands later.
 *
 * Filter drawer for status / date range / job lands in F1-010c. Until
 * then this page only exposes the free-text `q` field.
 */
import { requireAuth } from '@/lib/auth/require';
import { searchCandidates } from '@/lib/search/search';
import type { SearchFilters } from '@/lib/search/types';
import { createClient } from '@/lib/supabase/server';

import { CandidateCard } from './candidate-card';
import { Pagination } from './pagination';
import { SearchForm } from './search-form';

export const metadata = {
  title: 'Candidates — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;

interface PageProps {
  searchParams: {
    q?: string | string[];
    page?: string | string[];
  };
}

function firstOf(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1000);
}

export default async function CandidatesPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireAuth();

  const q = firstOf(searchParams.q)?.trim() ?? '';
  const page = parsePage(firstOf(searchParams.page));

  const filters: SearchFilters = {
    q: q.length > 0 ? q : null,
    status: null,
    rejectedAfter: null,
    rejectedBefore: null,
    jobId: null,
    page,
    pageSize: PAGE_SIZE,
  };

  const supabase = createClient();
  const results = await searchCandidates(supabase, filters);

  // Build the base params once so pagination preserves the q filter.
  const baseParams = new URLSearchParams();
  if (q.length > 0) baseParams.set('q', q);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Candidates
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Free-text search across name, email and pitch. Structured filters land in F1-010c.
        </p>
      </header>

      <div className="mb-6">
        <SearchForm initialQuery={q} />
      </div>

      {q.length === 0 ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            Start by typing a name, skill, or email to search the candidate database.
          </p>
        </section>
      ) : results.results.length === 0 ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            No candidates match <span className="font-mono text-text-primary">{q}</span>.
          </p>
        </section>
      ) : (
        <>
          <ul className="flex flex-col gap-3">
            {results.results.map((c) => (
              <li key={c.id}>
                <CandidateCard candidate={c} />
              </li>
            ))}
          </ul>
          <Pagination
            page={results.page}
            pageSize={results.pageSize}
            total={results.total}
            baseParams={baseParams}
          />
        </>
      )}
    </div>
  );
}
