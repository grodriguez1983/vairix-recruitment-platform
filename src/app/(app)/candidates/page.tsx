/**
 * `/candidates` — structured candidate search (UC-01 part 1).
 *
 * Server component: reads every filter from `searchParams` and calls
 * `searchCandidates` with an RLS-scoped client. Soft-delete and
 * tenant scoping are enforced by RLS. Semantic search (embeddings)
 * is deferred until the embeddings worker ships.
 *
 * The filter set mirrors `SearchFilters`: `q`, `status`,
 * `rejected_after`, `rejected_before`, `job_id`. Rejection-category
 * filtering is deferred because categories live on `evaluations`,
 * which is not synced yet.
 *
 * Jobs for the filter select are fetched here (small table, under
 * RLS the recruiter sees what they're allowed to).
 */
import { requireAuth } from '@/lib/auth/require';
import { searchCandidates } from '@/lib/search/search';
import type { SearchFilters } from '@/lib/search/types';
import { createClient } from '@/lib/supabase/server';

import { CandidateCard } from './candidate-card';
import { Pagination } from './pagination';
import { SearchForm, type JobOption, type PanelFilters } from './search-form';

export const metadata = {
  title: 'Candidates — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 20;
const APP_STATUSES = new Set(['active', 'rejected', 'hired', 'withdrawn']);
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISO_DATETIME_REGEX = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

interface PageProps {
  searchParams: {
    q?: string | string[];
    page?: string | string[];
    status?: string | string[];
    rejected_after?: string | string[];
    rejected_before?: string | string[];
    job_id?: string | string[];
    has_vairix_cv_sheet?: string | string[];
  };
}

function firstOf(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function parsePage(raw: string | undefined): number {
  if (!raw) return 1;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 1) return 1;
  return Math.min(parsed, 1000);
}

function parseStatus(raw: string | undefined): SearchFilters['status'] {
  if (!raw || !APP_STATUSES.has(raw)) return null;
  return raw as SearchFilters['status'];
}

function parseIsoDatetime(raw: string | undefined): string | null {
  if (!raw || !ISO_DATETIME_REGEX.test(raw)) return null;
  return raw;
}

function parseUuid(raw: string | undefined): string | null {
  if (!raw || !UUID_REGEX.test(raw)) return null;
  return raw;
}

function isoToDateInput(iso: string | null): string {
  // "YYYY-MM-DDTHH:MM:SSZ" → "YYYY-MM-DD" for `<input type="date">`.
  if (!iso) return '';
  return iso.slice(0, 10);
}

async function fetchJobOptions(
  supabase: ReturnType<typeof createClient>,
): Promise<readonly JobOption[]> {
  const { data, error } = await supabase
    .from('jobs')
    .select('id, title')
    .order('title', { ascending: true })
    .limit(500);
  if (error || !data) return [];
  return data
    .filter((row): row is { id: string; title: string } => Boolean(row?.id && row?.title))
    .map((row) => ({ id: row.id, title: row.title }));
}

export default async function CandidatesPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireAuth();

  const q = firstOf(searchParams.q)?.trim() ?? '';
  const page = parsePage(firstOf(searchParams.page));
  const status = parseStatus(firstOf(searchParams.status));
  const rejectedAfter = parseIsoDatetime(firstOf(searchParams.rejected_after));
  const rejectedBefore = parseIsoDatetime(firstOf(searchParams.rejected_before));
  const jobId = parseUuid(firstOf(searchParams.job_id));
  const hasVairixCvSheet = firstOf(searchParams.has_vairix_cv_sheet) === '1' ? true : null;

  const filters: SearchFilters = {
    q: q.length > 0 ? q : null,
    status,
    rejectedAfter,
    rejectedBefore,
    jobId,
    hasVairixCvSheet,
    page,
    pageSize: PAGE_SIZE,
  };

  const supabase = createClient();
  const [results, jobs] = await Promise.all([
    searchCandidates(supabase, filters),
    fetchJobOptions(supabase),
  ]);

  const hasAnyFilter =
    filters.q !== null ||
    filters.status !== null ||
    filters.rejectedAfter !== null ||
    filters.rejectedBefore !== null ||
    filters.jobId !== null ||
    filters.hasVairixCvSheet === true;

  // Preserve filters across pagination.
  const baseParams = new URLSearchParams();
  if (filters.q) baseParams.set('q', filters.q);
  if (filters.status) baseParams.set('status', filters.status);
  if (filters.rejectedAfter) baseParams.set('rejected_after', filters.rejectedAfter);
  if (filters.rejectedBefore) baseParams.set('rejected_before', filters.rejectedBefore);
  if (filters.jobId) baseParams.set('job_id', filters.jobId);
  if (filters.hasVairixCvSheet === true) baseParams.set('has_vairix_cv_sheet', '1');

  const initialPanel: PanelFilters = {
    q,
    status: status ?? '',
    rejectedAfter: isoToDateInput(rejectedAfter),
    rejectedBefore: isoToDateInput(rejectedBefore),
    jobId: jobId ?? '',
    hasVairixCvSheet: hasVairixCvSheet === true,
  };

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Candidates
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Search across name, email and pitch. Use filters to narrow by application status, date, or
          job.
        </p>
      </header>

      <div className="mb-6">
        <SearchForm initial={initialPanel} jobs={jobs} />
      </div>

      {!hasAnyFilter ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            Start by typing a query or selecting a filter to search the candidate database.
          </p>
        </section>
      ) : results.results.length === 0 ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">No candidates match the current filters.</p>
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
