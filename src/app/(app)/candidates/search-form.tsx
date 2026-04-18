/**
 * Search + structured-filter panel for `/candidates`.
 *
 * One client form containing:
 *   - free-text query input (`q`)
 *   - collapsible filter section with status, rejected-at date range,
 *     and job select
 *
 * On submit, the form serializes itself into URL params and
 * navigates via `router.push`. The server component at
 * `/candidates/page.tsx` re-runs with the new searchParams and
 * re-queries. A single source of truth: the URL.
 *
 * Resetting `?page=` on every apply prevents users from landing on
 * page 7 of a filtered-down result set.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition, type FormEvent } from 'react';

import { cn } from '@/lib/shared/cn';

export interface JobOption {
  id: string;
  title: string;
}

export interface PanelFilters {
  q: string;
  status: string;
  rejectedAfter: string;
  rejectedBefore: string;
  jobId: string;
  hasVairixCvSheet: boolean;
}

const STATUS_OPTIONS: readonly { value: string; label: string }[] = [
  { value: '', label: 'Any status' },
  { value: 'active', label: 'Active' },
  { value: 'rejected', label: 'Rejected' },
  { value: 'hired', label: 'Hired' },
  { value: 'withdrawn', label: 'Withdrawn' },
];

function activeFilterCount(f: PanelFilters): number {
  let n = 0;
  if (f.status) n += 1;
  if (f.rejectedAfter) n += 1;
  if (f.rejectedBefore) n += 1;
  if (f.jobId) n += 1;
  if (f.hasVairixCvSheet) n += 1;
  return n;
}

function toIsoStart(date: string): string {
  // `<input type="date">` gives "YYYY-MM-DD" in the user's locale
  // interpretation. We treat it as UTC start-of-day to keep filter
  // semantics deterministic across timezones.
  return `${date}T00:00:00Z`;
}

export function SearchForm({
  initial,
  jobs,
}: {
  initial: PanelFilters;
  jobs: readonly JobOption[];
}): JSX.Element {
  const router = useRouter();
  const [values, setValues] = useState<PanelFilters>(initial);
  const [showFilters, setShowFilters] = useState<boolean>(activeFilterCount(initial) > 0);
  const [pending, startTransition] = useTransition();

  function update<K extends keyof PanelFilters>(key: K, value: PanelFilters[K]): void {
    setValues((prev) => ({ ...prev, [key]: value }));
  }

  function reset(): void {
    const cleared: PanelFilters = {
      q: '',
      status: '',
      rejectedAfter: '',
      rejectedBefore: '',
      jobId: '',
      hasVairixCvSheet: false,
    };
    setValues(cleared);
    startTransition(() => {
      router.push('/candidates');
    });
  }

  function onSubmit(e: FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    const params = new URLSearchParams();
    const q = values.q.trim();
    if (q.length > 0) params.set('q', q);
    if (values.status) params.set('status', values.status);
    if (values.rejectedAfter) params.set('rejected_after', toIsoStart(values.rejectedAfter));
    if (values.rejectedBefore) params.set('rejected_before', toIsoStart(values.rejectedBefore));
    if (values.jobId) params.set('job_id', values.jobId);
    if (values.hasVairixCvSheet) params.set('has_vairix_cv_sheet', '1');
    const query = params.toString();
    startTransition(() => {
      router.push(query ? `/candidates?${query}` : '/candidates');
    });
  }

  const count = activeFilterCount(values);

  return (
    <form onSubmit={onSubmit} className="space-y-3" role="search">
      <div className="flex items-center gap-2">
        <label htmlFor="search-q" className="sr-only">
          Search candidates
        </label>
        <input
          id="search-q"
          name="q"
          type="search"
          autoComplete="off"
          value={values.q}
          onChange={(e) => update('q', e.target.value)}
          placeholder="Search by name, email, or pitch…"
          className={cn(
            'h-10 w-full rounded-sm border border-border bg-surface px-3 text-sm text-text-primary',
            'placeholder:text-text-muted focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent',
          )}
        />
        <button
          type="button"
          onClick={() => setShowFilters((s) => !s)}
          aria-expanded={showFilters}
          aria-controls="search-filters"
          className={cn(
            'inline-flex h-10 items-center justify-center gap-1 rounded-md border border-border px-3 text-xs font-medium text-text-primary transition-colors hover:border-accent',
            count > 0 && 'border-accent',
          )}
        >
          Filters
          {count > 0 && (
            <span className="ml-1 inline-flex h-5 min-w-[20px] items-center justify-center rounded-full bg-accent px-1.5 text-[10px] font-semibold text-bg">
              {count}
            </span>
          )}
        </button>
        <button
          type="submit"
          disabled={pending}
          className={cn(
            'inline-flex h-10 items-center justify-center rounded-md bg-accent px-5 text-sm font-medium text-bg',
            'transition-opacity hover:opacity-90 disabled:opacity-60',
          )}
        >
          {pending ? 'Searching…' : 'Search'}
        </button>
      </div>

      {showFilters && (
        <fieldset
          id="search-filters"
          className="grid gap-4 rounded-md border border-border bg-surface p-4 sm:grid-cols-2 lg:grid-cols-4"
        >
          <legend className="sr-only">Structured filters</legend>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Status
            <select
              value={values.status}
              onChange={(e) => update('status', e.target.value)}
              className="h-9 rounded-sm border border-border bg-bg px-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              {STATUS_OPTIONS.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Rejected after
            <input
              type="date"
              value={values.rejectedAfter}
              onChange={(e) => update('rejectedAfter', e.target.value)}
              className="h-9 rounded-sm border border-border bg-bg px-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Rejected before
            <input
              type="date"
              value={values.rejectedBefore}
              onChange={(e) => update('rejectedBefore', e.target.value)}
              className="h-9 rounded-sm border border-border bg-bg px-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            />
          </label>

          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Job
            <select
              value={values.jobId}
              onChange={(e) => update('jobId', e.target.value)}
              className="h-9 rounded-sm border border-border bg-bg px-2 text-sm text-text-primary focus:border-accent focus:outline-none"
            >
              <option value="">Any job</option>
              {jobs.map((job) => (
                <option key={job.id} value={job.id}>
                  {job.title}
                </option>
              ))}
            </select>
          </label>

          <label className="col-span-full flex items-center gap-2 text-xs text-text-primary sm:col-span-2 lg:col-span-4">
            <input
              type="checkbox"
              checked={values.hasVairixCvSheet}
              onChange={(e) => update('hasVairixCvSheet', e.target.checked)}
              className="h-4 w-4 rounded-sm border-border bg-bg text-accent focus:ring-accent"
            />
            <span>
              Only candidates with a VAIRIX CV sheet{' '}
              <span className="text-text-muted">
                (Google Sheets link from Teamtailor or uploaded xlsx)
              </span>
            </span>
          </label>

          {count > 0 && (
            <button
              type="button"
              onClick={reset}
              className="col-span-full justify-self-start text-xs font-medium text-accent hover:underline underline-offset-4"
            >
              Clear all filters
            </button>
          )}
        </fieldset>
      )}
    </form>
  );
}
