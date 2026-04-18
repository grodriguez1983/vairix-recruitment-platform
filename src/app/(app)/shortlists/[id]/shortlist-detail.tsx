/**
 * Client component for shortlist detail page.
 *
 * Handles interactive actions: remove candidate (optimistic) and
 * archive. CSV export is a plain `<a>` to a route handler. Once a
 * shortlist is archived this component renders a read-only view.
 */
'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { archiveShortlistAction, removeCandidateAction } from '../actions';

export interface ShortlistHeader {
  id: string;
  name: string;
  description: string | null;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShortlistCandidateRow {
  candidate_id: string;
  note: string | null;
  added_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export interface ShortlistDetailProps {
  shortlist: ShortlistHeader;
  initialCandidates: ShortlistCandidateRow[];
}

function displayName(r: ShortlistCandidateRow): string {
  const parts = [r.first_name, r.last_name].filter((v): v is string => Boolean(v && v.trim()));
  if (parts.length > 0) return parts.join(' ');
  return r.email ?? 'Unnamed candidate';
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return '—';
  }
}

export function ShortlistDetail({
  shortlist,
  initialCandidates,
}: ShortlistDetailProps): JSX.Element {
  const router = useRouter();
  const [candidates, setCandidates] = useState<ShortlistCandidateRow[]>(initialCandidates);
  const [archivedAt, setArchivedAt] = useState<string | null>(shortlist.archived_at);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();

  const isArchived = archivedAt !== null;

  function handleRemove(candidateId: string): void {
    setError(null);
    startTransition(async () => {
      const res = await removeCandidateAction(shortlist.id, candidateId);
      if (!res.ok) {
        setError(res.error?.message ?? 'Failed to remove candidate');
        return;
      }
      setCandidates((prev) => prev.filter((c) => c.candidate_id !== candidateId));
    });
  }

  function handleArchive(): void {
    if (!confirm(`Archive shortlist "${shortlist.name}"? This hides it from the active list.`)) {
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await archiveShortlistAction(shortlist.id);
      if (!res.ok) {
        setError(res.error?.message ?? 'Failed to archive');
        return;
      }
      setArchivedAt(new Date().toISOString());
      router.refresh();
    });
  }

  return (
    <>
      <header className="mb-6 flex flex-wrap items-start justify-between gap-4 rounded-lg border border-border bg-surface p-6">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
              {shortlist.name}
            </h1>
            {isArchived && (
              <span className="inline-flex h-6 items-center rounded-sm bg-warning/10 px-2 font-mono text-[10px] uppercase tracking-widest text-warning">
                archived
              </span>
            )}
          </div>
          {shortlist.description && (
            <p className="mt-2 text-sm text-text-muted">{shortlist.description}</p>
          )}
          <p className="mt-3 font-mono text-xs text-text-muted">
            created {formatDate(shortlist.created_at)} · updated {formatDate(shortlist.updated_at)}
            {archivedAt && ` · archived ${formatDate(archivedAt)}`}
          </p>
        </div>
        <div className="flex shrink-0 flex-wrap gap-2">
          <a
            href={`/api/shortlists/${shortlist.id}/export.csv`}
            className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-text-primary hover:bg-surface"
          >
            Export CSV
          </a>
          {!isArchived && (
            <button
              type="button"
              onClick={handleArchive}
              disabled={isPending}
              className="rounded-md border border-border bg-bg px-3 py-1.5 text-xs font-medium text-danger hover:bg-surface disabled:opacity-40"
            >
              {isPending ? 'Archiving…' : 'Archive'}
            </button>
          )}
        </div>
      </header>

      {error && (
        <p role="alert" className="mb-4 text-xs text-danger">
          {error}
        </p>
      )}

      <section>
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
          Candidates{' '}
          <span className="font-mono text-xs font-normal text-text-muted">
            ({candidates.length})
          </span>
        </h2>
        {candidates.length === 0 ? (
          <div className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
            <p className="text-sm text-text-muted">
              No candidates yet. Add them from a candidate profile.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {candidates.map((c) => (
              <li
                key={c.candidate_id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4"
              >
                <div className="min-w-0 flex-1">
                  <Link
                    href={`/candidates/${c.candidate_id}`}
                    className="font-display text-sm font-medium text-text-primary hover:text-accent"
                  >
                    {displayName(c)}
                  </Link>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {c.email ?? '—'} · added {formatDate(c.added_at)}
                  </p>
                  {c.note && (
                    <p className="mt-1 line-clamp-2 text-xs italic text-text-muted">“{c.note}”</p>
                  )}
                </div>
                {!isArchived && (
                  <button
                    type="button"
                    onClick={() => handleRemove(c.candidate_id)}
                    disabled={isPending}
                    aria-label={`Remove ${displayName(c)}`}
                    className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-text-muted hover:text-danger disabled:opacity-40"
                  >
                    Remove
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </section>
    </>
  );
}
