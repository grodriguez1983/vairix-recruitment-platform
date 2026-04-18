/**
 * Prev / next pagination for candidate results. Renders server-side
 * as plain links; the `/candidates` server component re-runs on
 * navigation and re-queries with the new page number.
 */
import Link from 'next/link';

import { cn } from '@/lib/shared/cn';

function buildHref(params: URLSearchParams, page: number): string {
  const next = new URLSearchParams(params.toString());
  if (page <= 1) {
    next.delete('page');
  } else {
    next.set('page', String(page));
  }
  const query = next.toString();
  return query ? `/candidates?${query}` : '/candidates';
}

export function Pagination({
  page,
  pageSize,
  total,
  baseParams,
}: {
  page: number;
  pageSize: number;
  total: number;
  baseParams: URLSearchParams;
}): JSX.Element | null {
  if (total <= pageSize) return null;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const prevDisabled = page <= 1;
  const nextDisabled = page >= totalPages;

  const linkClass = (disabled: boolean): string =>
    cn(
      'inline-flex h-9 items-center justify-center rounded-md border border-border px-4 text-xs font-medium transition-colors',
      disabled
        ? 'pointer-events-none text-text-muted opacity-50'
        : 'text-text-primary hover:border-accent',
    );

  return (
    <nav aria-label="Pagination" className="mt-6 flex items-center justify-between">
      <p className="text-xs text-text-muted">
        Page {page} of {totalPages} — {total} candidate{total === 1 ? '' : 's'}
      </p>
      <div className="flex items-center gap-2">
        <Link
          aria-disabled={prevDisabled}
          href={buildHref(baseParams, page - 1)}
          className={linkClass(prevDisabled)}
        >
          ← Prev
        </Link>
        <Link
          aria-disabled={nextDisabled}
          href={buildHref(baseParams, page + 1)}
          className={linkClass(nextDisabled)}
        >
          Next →
        </Link>
      </div>
    </nav>
  );
}
