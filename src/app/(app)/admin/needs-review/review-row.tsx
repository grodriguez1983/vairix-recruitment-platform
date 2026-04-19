/**
 * Client component: category picker + dismiss button for a single
 * needs-review evaluation row.
 *
 * - Select a category and click "save" → reclassifies + clears the
 *   flag via `reclassifyAction`.
 * - Click "dismiss" → accepts the current fallback ('other') and
 *   clears the flag via `dismissAction`.
 *
 * `useTransition` keeps the row responsive during the server round
 * trip; errors render inline so the admin can retry.
 */
'use client';

import { useState, useTransition } from 'react';

import { dismissAction, reclassifyAction } from './actions';

interface Props {
  evaluationId: string;
  categories: ReadonlyArray<{ id: string; code: string; display_name: string }>;
  defaultCategoryId: string | null;
}

export function ReviewRow({ evaluationId, categories, defaultCategoryId }: Props): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string>(defaultCategoryId ?? '');

  function onSave(): void {
    setError(null);
    if (!selected) {
      setError('pick a category first');
      return;
    }
    startTransition(async () => {
      const res = await reclassifyAction(evaluationId, selected);
      if (!res.ok) setError(res.error?.message ?? 'failed');
    });
  }

  function onDismiss(): void {
    setError(null);
    startTransition(async () => {
      const res = await dismissAction(evaluationId);
      if (!res.ok) setError(res.error?.message ?? 'failed');
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-1">
        <select
          value={selected}
          onChange={(e) => setSelected(e.target.value)}
          disabled={isPending}
          className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
        >
          <option value="">pick category…</option>
          {categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.display_name}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={onSave}
          disabled={isPending}
          className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-primary hover:bg-surface disabled:opacity-50"
        >
          {isPending ? '…' : 'save'}
        </button>
        <button
          type="button"
          onClick={onDismiss}
          disabled={isPending}
          className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-50"
        >
          dismiss
        </button>
      </div>
      {error && (
        <span role="alert" className="font-mono text-[10px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
