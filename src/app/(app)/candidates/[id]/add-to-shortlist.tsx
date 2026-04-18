/**
 * Client component for adding a candidate to a shortlist from the
 * candidate profile (UC-03).
 *
 * Shows a native `<select>` of active shortlists plus an optional
 * note input. On submit calls the server action and surfaces the
 * result inline. We intentionally avoid a modal/combobox here —
 * the active-shortlist set is small (≤ dozens for 5–15 users).
 */
'use client';

import { useState, useTransition } from 'react';

import { addCandidateAction } from '@/app/(app)/shortlists/actions';

export interface ShortlistOption {
  id: string;
  name: string;
}

export interface AddToShortlistProps {
  candidateId: string;
  shortlists: ShortlistOption[];
}

export function AddToShortlist({ candidateId, shortlists }: AddToShortlistProps): JSX.Element {
  const [selected, setSelected] = useState<string>('');
  const [note, setNote] = useState<string>('');
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [isPending, startTransition] = useTransition();

  function handleSubmit(e: React.FormEvent<HTMLFormElement>): void {
    e.preventDefault();
    if (!selected) return;
    setMessage(null);
    const trimmedNote = note.trim();
    startTransition(async () => {
      const res = await addCandidateAction(
        selected,
        candidateId,
        trimmedNote.length > 0 ? trimmedNote : null,
      );
      if (!res.ok) {
        setMessage({ kind: 'err', text: res.error?.message ?? 'Failed to add' });
        return;
      }
      const sl = shortlists.find((s) => s.id === selected);
      setMessage({ kind: 'ok', text: `Added to "${sl?.name ?? 'shortlist'}"` });
      setNote('');
    });
  }

  if (shortlists.length === 0) {
    return (
      <section className="mb-6">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">Shortlists</h2>
        <div className="rounded-lg border border-border border-dashed bg-surface p-5 text-sm text-text-muted">
          No active shortlists.{' '}
          <a href="/shortlists" className="text-accent hover:underline underline-offset-4">
            Create one →
          </a>
        </div>
      </section>
    );
  }

  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">Shortlists</h2>
      <form
        onSubmit={handleSubmit}
        className="flex flex-col gap-2 rounded-lg border border-border bg-surface p-5"
      >
        <div className="flex flex-col gap-2 sm:flex-row">
          <label htmlFor="sl-select" className="sr-only">
            Shortlist
          </label>
          <select
            id="sl-select"
            value={selected}
            onChange={(e) => setSelected(e.target.value)}
            disabled={isPending}
            className="min-w-0 flex-1 rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
          >
            <option value="">Select a shortlist…</option>
            {shortlists.map((s) => (
              <option key={s.id} value={s.id}>
                {s.name}
              </option>
            ))}
          </select>
          <button
            type="submit"
            disabled={isPending || !selected}
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface disabled:opacity-40"
          >
            {isPending ? 'Adding…' : 'Add to shortlist'}
          </button>
        </div>
        <label htmlFor="sl-note" className="sr-only">
          Note (optional)
        </label>
        <input
          id="sl-note"
          type="text"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          disabled={isPending}
          placeholder="Optional note (e.g. 'Strong Postgres')"
          className="rounded-md border border-border bg-bg px-3 py-1.5 font-mono text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
        />
        {message && (
          <p
            role={message.kind === 'err' ? 'alert' : 'status'}
            className={`mt-1 text-xs ${message.kind === 'err' ? 'text-danger' : 'text-accent'}`}
          >
            {message.text}
          </p>
        )}
      </form>
    </section>
  );
}
