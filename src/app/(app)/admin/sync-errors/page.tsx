/**
 * `/admin/sync-errors` — operator view of ETL failures (F2-004).
 *
 * Admin-only. Shows unresolved rows by default (the ones that need
 * attention), with filters for entity + includeResolved and simple
 * offset pagination. Each row has a Resolve button that marks
 * `resolved_at` via a server action.
 *
 * Payload is rendered as truncated JSON on hover-friendly `details`
 * blocks so the admin can inspect without another page load.
 */
import Link from 'next/link';

import { requireRole } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { countSyncErrors, listSyncErrors, type SyncErrorRow } from '@/lib/sync-errors/service';

import { ResolveButton } from './resolve-button';

export const metadata = {
  title: 'Sync errors — Admin',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: {
    entity?: string | string[];
    resolved?: string | string[];
    page?: string | string[];
  };
}

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().replace('T', ' ').slice(0, 19);
  } catch {
    return '—';
  }
}

function formatPayload(payload: unknown): string {
  try {
    const str = JSON.stringify(payload, null, 2);
    return str.length > 600 ? `${str.slice(0, 600)}…` : str;
  } catch {
    return '<unserializable>';
  }
}

export default async function SyncErrorsPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireRole('admin');
  const supabase = createClient();

  const entityParam = firstOf(searchParams.entity);
  const includeResolved = firstOf(searchParams.resolved) === 'all';
  const rawPage = Number.parseInt(firstOf(searchParams.page) ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const [rows, total] = await Promise.all([
    listSyncErrors(supabase, {
      entity: entityParam,
      includeResolved,
      limit: PAGE_SIZE,
      offset,
    }).catch(() => [] as SyncErrorRow[]),
    countSyncErrors(supabase, {
      entity: entityParam,
      includeResolved,
    }).catch(() => 0),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function hrefFor(overrides: Partial<{ entity: string; resolved: string; page: number }>): string {
    const params = new URLSearchParams();
    const e = overrides.entity ?? entityParam;
    const r = overrides.resolved ?? (includeResolved ? 'all' : undefined);
    const p = overrides.page ?? page;
    if (e) params.set('entity', e);
    if (r) params.set('resolved', r);
    if (p !== 1) params.set('page', String(p));
    const qs = params.toString();
    return qs ? `/admin/sync-errors?${qs}` : '/admin/sync-errors';
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <Link href="/admin" className="font-mono text-xs text-text-muted hover:text-text-primary">
          ← Admin
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Sync errors
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          ETL row failures. Fix the root cause, then mark resolved here.
        </p>
      </header>

      <section className="mb-4 flex flex-wrap items-center gap-2 rounded-lg border border-border bg-surface p-3">
        <form method="get" className="flex flex-wrap items-center gap-2">
          <label htmlFor="entity" className="font-mono text-[10px] uppercase text-text-muted">
            entity
          </label>
          <input
            id="entity"
            name="entity"
            defaultValue={entityParam ?? ''}
            placeholder="any"
            className="w-40 rounded-md border border-border bg-bg px-2 py-1 font-mono text-xs text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
          <label className="flex items-center gap-1 font-mono text-[10px] uppercase text-text-muted">
            <input
              type="checkbox"
              name="resolved"
              value="all"
              defaultChecked={includeResolved}
              className="h-3 w-3"
            />
            include resolved
          </label>
          <button
            type="submit"
            className="rounded-md border border-border bg-bg px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-primary hover:bg-surface"
          >
            apply
          </button>
          <Link
            href="/admin/sync-errors"
            className="font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-primary"
          >
            reset
          </Link>
        </form>
        <span className="ml-auto font-mono text-[11px] text-text-muted">
          {total} row{total === 1 ? '' : 's'}
        </span>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            {includeResolved ? 'No sync errors recorded yet.' : 'No unresolved sync errors. 🎉'}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {rows.map((r) => (
            <li
              key={r.id}
              className="rounded-md border border-border bg-surface p-4 font-mono text-xs"
            >
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2 text-[11px]">
                    <span className="rounded bg-bg px-1.5 py-0.5 uppercase tracking-wide text-text-primary">
                      {r.entity}
                    </span>
                    {r.teamtailor_id && (
                      <span className="text-text-muted">tt:{r.teamtailor_id}</span>
                    )}
                    {r.error_code && <span className="text-danger">{r.error_code}</span>}
                    {r.resolved_at && (
                      <span className="rounded bg-bg px-1.5 py-0.5 text-[10px] uppercase text-success">
                        resolved
                      </span>
                    )}
                  </div>
                  <p className="mt-2 text-text-primary">{r.error_message ?? '—'}</p>
                  <p className="mt-1 text-[10px] text-text-muted">
                    run {formatDateTime(r.run_started_at)} · created {formatDateTime(r.created_at)}
                    {r.resolved_at && ` · resolved ${formatDateTime(r.resolved_at)}`}
                  </p>
                </div>
                {!r.resolved_at && <ResolveButton id={r.id} />}
              </div>
              {r.payload !== null && r.payload !== undefined && (
                <details className="mt-2">
                  <summary className="cursor-pointer text-[10px] uppercase tracking-wider text-text-muted">
                    payload
                  </summary>
                  <pre className="mt-1 max-h-64 overflow-auto rounded bg-bg p-2 text-[10px] text-text-primary">
                    {formatPayload(r.payload)}
                  </pre>
                </details>
              )}
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between font-mono text-[11px] text-text-muted">
          <Link
            href={hrefFor({ page: Math.max(1, page - 1) })}
            aria-disabled={page === 1}
            className={page === 1 ? 'pointer-events-none opacity-40' : 'hover:text-text-primary'}
          >
            ← prev
          </Link>
          <span>
            page {page} of {pageCount}
          </span>
          <Link
            href={hrefFor({ page: Math.min(pageCount, page + 1) })}
            aria-disabled={page >= pageCount}
            className={
              page >= pageCount ? 'pointer-events-none opacity-40' : 'hover:text-text-primary'
            }
          >
            next →
          </Link>
        </nav>
      )}
    </div>
  );
}
