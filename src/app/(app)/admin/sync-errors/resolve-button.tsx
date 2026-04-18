/**
 * Inline "Resolve" button for a single sync_error row.
 *
 * Uses `useTransition` so the row updates without a full reload while
 * the server action runs. Shows the error message inline on failure
 * rather than throwing — the admin can retry without losing context.
 */
'use client';

import { useState, useTransition } from 'react';

import { resolveSyncErrorAction } from './actions';

export function ResolveButton({ id }: { id: string }): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function onClick(): void {
    setError(null);
    startTransition(async () => {
      const res = await resolveSyncErrorAction(id);
      if (!res.ok) setError(res.error?.message ?? 'failed');
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <button
        type="button"
        onClick={onClick}
        disabled={isPending}
        className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:bg-surface hover:text-text-primary disabled:opacity-50"
      >
        {isPending ? 'resolving…' : 'resolve'}
      </button>
      {error && (
        <span role="alert" className="font-mono text-[10px] text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
