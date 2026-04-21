/**
 * Client row for `/admin/skills/uncataloged`.
 *
 * Two actions per row:
 *   - "Add to catalog" → prompts for canonical name + slug (seeded
 *     from the normalized alias) + optional category, then calls
 *     addToCatalogAction which inserts the skill and runs the
 *     incremental reconcile.
 *   - "Blacklist" → one-click, hides the alias from future reports
 *     via skills_blacklist.
 *
 * `useTransition` keeps the row responsive; errors and success
 * messages render inline.
 */
'use client';

import { useState, useTransition } from 'react';

import { addToCatalogAction, blacklistAction } from './actions';

interface Props {
  aliasNormalized: string;
  count: number;
  samples: string[];
}

function defaultSlugFrom(alias: string): string {
  // slug format is stricter than alias: no spaces, lowercase, safe
  // punctuation only. Replace whitespace with '-' as a reasonable
  // default the admin can still edit.
  return alias.replace(/\s+/g, '-');
}

function defaultCanonicalFrom(alias: string): string {
  // Title-case on word boundaries; operator can still tweak.
  return alias
    .split(/\s+/)
    .map((w) => (w.length === 0 ? w : w[0]!.toUpperCase() + w.slice(1)))
    .join(' ');
}

export function UncatalogedRowActions({ aliasNormalized, count, samples }: Props): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [editing, setEditing] = useState<boolean>(false);
  const [canonical, setCanonical] = useState<string>(defaultCanonicalFrom(aliasNormalized));
  const [slug, setSlug] = useState<string>(defaultSlugFrom(aliasNormalized));
  const [category, setCategory] = useState<string>('');

  function onAdd(): void {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const res = await addToCatalogAction({
        canonical_name: canonical.trim(),
        slug: slug.trim().toLowerCase(),
        category: category.trim() === '' ? null : category.trim(),
        extra_aliases: [aliasNormalized],
      });
      if (!res.ok) {
        setError(res.error?.message ?? 'failed');
        return;
      }
      const r = res.data;
      setStatus(
        r
          ? `added · resolved ${r.reconcile.updated} row${r.reconcile.updated === 1 ? '' : 's'}`
          : 'added',
      );
      setEditing(false);
    });
  }

  function onBlacklist(): void {
    setError(null);
    setStatus(null);
    startTransition(async () => {
      const res = await blacklistAction(aliasNormalized);
      if (!res.ok) {
        setError(res.error?.message ?? 'failed');
        return;
      }
      setStatus('blacklisted');
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-mono text-sm text-text-primary">{aliasNormalized}</span>
            <span className="rounded bg-bg px-1.5 py-0.5 font-mono text-[10px] text-text-muted">
              ×{count}
            </span>
          </div>
          {samples.length > 0 && (
            <p className="mt-1 font-mono text-[10px] text-text-muted">
              samples: {samples.map((s) => `"${s}"`).join(' · ')}
            </p>
          )}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {!editing && (
            <button
              type="button"
              onClick={() => setEditing(true)}
              disabled={isPending}
              className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-primary hover:bg-surface disabled:opacity-50"
            >
              add
            </button>
          )}
          <button
            type="button"
            onClick={onBlacklist}
            disabled={isPending}
            className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-50"
          >
            blacklist
          </button>
        </div>
      </div>

      {editing && (
        <div className="flex flex-wrap items-center gap-2 rounded border border-border bg-bg p-2">
          <label className="flex min-w-[180px] flex-1 flex-col gap-0.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-muted">
              canonical name
            </span>
            <input
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              disabled={isPending}
              className="rounded border border-border bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="flex min-w-[120px] flex-1 flex-col gap-0.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-muted">
              slug
            </span>
            <input
              value={slug}
              onChange={(e) => setSlug(e.target.value)}
              disabled={isPending}
              className="rounded border border-border bg-surface px-2 py-1 font-mono text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="flex min-w-[100px] flex-1 flex-col gap-0.5">
            <span className="font-mono text-[9px] uppercase tracking-wider text-text-muted">
              category (optional)
            </span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isPending}
              className="rounded border border-border bg-surface px-2 py-1 text-xs text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <div className="flex gap-1 self-end">
            <button
              type="button"
              onClick={onAdd}
              disabled={isPending}
              className="rounded border border-accent bg-accent/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-accent hover:bg-accent/20 disabled:opacity-50"
            >
              {isPending ? '…' : 'save'}
            </button>
            <button
              type="button"
              onClick={() => setEditing(false)}
              disabled={isPending}
              className="rounded border border-border bg-surface px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <p role="alert" className="font-mono text-[10px] text-danger">
          {error}
        </p>
      )}
      {status && !error && <p className="font-mono text-[10px] text-accent">{status}</p>}
    </div>
  );
}
