/**
 * `/shortlists` — index of active shortlists (UC-03).
 *
 * Server component: lists active shortlists for the current caller
 * (RLS scopes rows). Archived lists are hidden here; they live on
 * `/shortlists/archived` (out of F1-013 scope — can be revisited
 * when archive management becomes a flow rather than a one-shot).
 *
 * The create form posts to a Server Action that redirects to the
 * new shortlist's detail page on success, or back here with an
 * `?error=` param on failure.
 */
import Link from 'next/link';

import { requireAuth } from '@/lib/auth/require';
import { listActiveShortlists } from '@/lib/shortlists/service';
import { createClient } from '@/lib/supabase/server';

import { createShortlistAndRedirect } from './actions';

export const metadata = {
  title: 'Shortlists — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

interface PageProps {
  searchParams: { error?: string | string[] };
}

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

export default async function ShortlistsPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireAuth();
  const supabase = createClient();
  const shortlists = await listActiveShortlists(supabase).catch(() => []);
  const err = firstOf(searchParams.error);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Shortlists
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Curated lists of candidates. Export to CSV to share outside the platform.
        </p>
      </header>

      <section className="mb-8 rounded-lg border border-border bg-surface p-5">
        <h2 className="mb-3 font-display text-sm font-semibold text-text-primary">
          Create shortlist
        </h2>
        <form action={createShortlistAndRedirect} className="flex flex-col gap-3 sm:flex-row">
          <label htmlFor="sl-name" className="sr-only">
            Name
          </label>
          <input
            id="sl-name"
            name="name"
            required
            maxLength={120}
            placeholder="e.g. Hot backend candidates"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <label htmlFor="sl-desc" className="sr-only">
            Description
          </label>
          <input
            id="sl-desc"
            name="description"
            maxLength={500}
            placeholder="Description (optional)"
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <button
            type="submit"
            className="rounded-md border border-border bg-bg px-4 py-1.5 text-xs font-medium text-text-primary hover:bg-surface"
          >
            Create
          </button>
        </form>
        {err && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {err}
          </p>
        )}
      </section>

      <section>
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
          Active{' '}
          <span className="font-mono text-xs font-normal text-text-muted">
            ({shortlists.length})
          </span>
        </h2>
        {shortlists.length === 0 ? (
          <div className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
            <p className="text-sm text-text-muted">
              No shortlists yet. Create one above to get started.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {shortlists.map((sl) => (
              <li key={sl.id}>
                <Link
                  href={`/shortlists/${sl.id}`}
                  className="block rounded-md border border-border bg-surface p-4 transition-colors hover:border-accent/40"
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0 flex-1">
                      <p className="font-display text-sm font-medium text-text-primary">
                        {sl.name}
                      </p>
                      {sl.description && (
                        <p className="mt-1 line-clamp-2 text-xs text-text-muted">
                          {sl.description}
                        </p>
                      )}
                    </div>
                    <div className="shrink-0 text-right text-xs text-text-muted">
                      <p className="font-mono text-text-primary">{sl.candidate_count}</p>
                      <p>candidates</p>
                      <p className="mt-1">updated {formatDate(sl.updated_at)}</p>
                    </div>
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
