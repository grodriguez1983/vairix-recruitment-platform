/**
 * `/admin/skills` — list + search of the catalog (ADR-013 §6).
 *
 * Admin-only. Shows slug, canonical name, category, alias count, and
 * deprecated state. Search is case-insensitive across slug and
 * canonical_name. A toggle reveals deprecated rows for rescue
 * operations.
 */
import Link from 'next/link';

import { requireRole } from '@/lib/auth/require';
import { listSkills } from '@/lib/skills/admin-service';
import { createClient } from '@/lib/supabase/server';

export const metadata = {
  title: 'Skills catalog — Admin',
};

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

interface PageProps {
  searchParams: {
    q?: string | string[];
    page?: string | string[];
    deprecated?: string | string[];
  };
}

function firstOf(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

export default async function SkillsAdminPage({ searchParams }: PageProps): Promise<JSX.Element> {
  await requireRole('admin');
  const db = createClient();

  const q = (firstOf(searchParams.q) ?? '').trim();
  const includeDeprecated = firstOf(searchParams.deprecated) === '1';
  const rawPage = Number.parseInt(firstOf(searchParams.page) ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage > 0 ? rawPage : 1;
  const offset = (page - 1) * PAGE_SIZE;

  const { rows, total } = await listSkills(db, {
    search: q,
    includeDeprecated,
    limit: PAGE_SIZE,
    offset,
  }).catch(() => ({ rows: [], total: 0 }));
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));

  function hrefFor(p: number): string {
    const params = new URLSearchParams();
    if (q) params.set('q', q);
    if (includeDeprecated) params.set('deprecated', '1');
    if (p > 1) params.set('page', String(p));
    const qs = params.toString();
    return qs ? `/admin/skills?${qs}` : '/admin/skills';
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6">
        <Link href="/admin" className="font-mono text-xs text-text-muted hover:text-text-primary">
          ← Admin
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Skills catalog
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Canonical skills + aliases. Promote uncataloged strings from{' '}
          <Link
            href="/admin/skills/uncataloged"
            className="text-text-primary underline hover:text-accent"
          >
            /admin/skills/uncataloged
          </Link>
          , edit canonical names, manage aliases.
        </p>
      </header>

      <form className="mb-4 flex flex-wrap items-end gap-3" method="get">
        <label className="flex flex-1 flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            search
          </span>
          <input
            type="search"
            name="q"
            defaultValue={q}
            placeholder="slug or canonical name"
            className="rounded border border-border bg-surface px-3 py-2 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
        <label className="flex items-center gap-2 font-mono text-[11px] text-text-muted">
          <input
            type="checkbox"
            name="deprecated"
            value="1"
            defaultChecked={includeDeprecated}
            className="h-3 w-3"
          />
          include deprecated
        </label>
        <button
          type="submit"
          className="rounded border border-border bg-bg px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-primary hover:bg-surface"
        >
          apply
        </button>
      </form>

      <section className="mb-2 font-mono text-[11px] text-text-muted">
        {total} skill{total === 1 ? '' : 's'}
        {q && ` matching "${q}"`}
      </section>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">No skills found.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-1">
          {rows.map((s) => (
            <li key={s.id}>
              <Link
                href={`/admin/skills/${s.id}`}
                className="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-2 hover:border-accent/40"
              >
                <span className="flex-1 truncate font-mono text-sm text-text-primary">
                  {s.slug}
                </span>
                <span className="hidden flex-1 truncate text-sm text-text-muted sm:block">
                  {s.canonical_name}
                </span>
                {s.category && (
                  <span className="hidden rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-muted sm:inline">
                    {s.category}
                  </span>
                )}
                <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
                  {s.alias_count} alias{s.alias_count === 1 ? '' : 'es'}
                </span>
                {s.deprecated_at && (
                  <span className="rounded bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-wider text-danger">
                    deprecated
                  </span>
                )}
              </Link>
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
