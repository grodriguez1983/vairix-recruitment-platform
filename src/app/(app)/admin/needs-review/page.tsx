/**
 * `/admin/needs-review` — operator view of evaluations flagged by the
 * rejection normalizer as ambiguous (F2-004, ADR-007 §5).
 *
 * Admin-only. Lists the `evaluations` rows with `needs_review=true`,
 * shows the rejection reason + current (fallback) category, and
 * provides per-row actions to:
 *   - reclassify into a concrete category, or
 *   - dismiss (accept the 'other' fallback).
 *
 * Either action clears the `needs_review` flag so the row exits the
 * queue.
 */
import Link from 'next/link';

import { requireRole } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import {
  countNeedsReview,
  listNeedsReview,
  listRejectionCategories,
  type NeedsReviewRow,
  type RejectionCategoryRow,
} from '@/lib/needs-review/service';

import { ReviewRow } from './review-row';

export const metadata = {
  title: 'Needs review — Admin',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: {
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

function candidateName(row: NeedsReviewRow): string {
  const first = row.candidate_first_name ?? '';
  const last = row.candidate_last_name ?? '';
  const full = `${first} ${last}`.trim();
  return full.length > 0 ? full : '—';
}

export default async function NeedsReviewPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireRole('admin');
  const supabase = createClient();

  const rawPage = Number.parseInt(firstOf(searchParams.page) ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const [rows, total, categories] = await Promise.all([
    listNeedsReview(supabase, { limit: PAGE_SIZE, offset }).catch(() => [] as NeedsReviewRow[]),
    countNeedsReview(supabase).catch(() => 0),
    listRejectionCategories(supabase).catch(() => [] as RejectionCategoryRow[]),
  ]);

  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function hrefFor(p: number): string {
    return p === 1 ? '/admin/needs-review' : `/admin/needs-review?page=${p}`;
  }

  return (
    <div className="mx-auto max-w-6xl">
      <header className="mb-6">
        <Link href="/admin" className="font-mono text-xs text-text-muted hover:text-text-primary">
          ← Admin
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Needs review
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Evaluations where the rejection normalizer fell back to{' '}
          <span className="font-mono text-xs">other</span>. Reclassify to the correct bucket or
          dismiss to accept the fallback.
        </p>
      </header>

      <section className="mb-4 flex items-center justify-between rounded-lg border border-border bg-surface p-3 font-mono text-[11px] text-text-muted">
        <span>
          {total} pending row{total === 1 ? '' : 's'}
        </span>
      </section>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">Queue is empty. 🎉</p>
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
                    <Link
                      href={`/candidates/${r.candidate_id}`}
                      className="rounded bg-bg px-1.5 py-0.5 uppercase tracking-wide text-text-primary hover:text-accent"
                    >
                      {candidateName(r)}
                    </Link>
                    {r.decision && <span className="text-text-muted">· {r.decision}</span>}
                  </div>
                  <p className="mt-2 text-text-primary">{r.rejection_reason ?? '—'}</p>
                  <p className="mt-1 text-[10px] text-text-muted">
                    attempted {formatDateTime(r.normalization_attempted_at)} · created{' '}
                    {formatDateTime(r.created_at)}
                  </p>
                </div>
                <ReviewRow
                  evaluationId={r.id}
                  categories={categories}
                  defaultCategoryId={r.rejection_category_id}
                />
              </div>
            </li>
          ))}
        </ul>
      )}

      {pageCount > 1 && (
        <nav className="mt-4 flex items-center justify-between font-mono text-[11px] text-text-muted">
          <Link
            href={hrefFor(Math.max(1, page - 1))}
            aria-disabled={page === 1}
            className={page === 1 ? 'pointer-events-none opacity-40' : 'hover:text-text-primary'}
          >
            ← prev
          </Link>
          <span>
            page {page} of {pageCount}
          </span>
          <Link
            href={hrefFor(Math.min(pageCount, page + 1))}
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
