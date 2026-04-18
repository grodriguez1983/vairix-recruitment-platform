/**
 * Candidate card (list item). Pure display, no behavior.
 *
 * Follows ui-style-guide.md §8: surface bg, border, radius-lg, hover
 * lifts the border to `accent-primary`. When the candidate is
 * shortlisted/marked, the bottom-left corner uses `radius-xl` to
 * highlight — shortlists don't exist yet (F1-014), so `highlighted`
 * is optional and defaults to false.
 */
import Link from 'next/link';

import { cn } from '@/lib/shared/cn';
import type { SearchResultCandidate } from '@/lib/search/types';

function initialsFor(c: SearchResultCandidate): string {
  const first = c.firstName?.trim().charAt(0) ?? '';
  const last = c.lastName?.trim().charAt(0) ?? '';
  const combined = `${first}${last}`.toUpperCase();
  if (combined.length > 0) return combined;
  return c.email?.trim().charAt(0).toUpperCase() ?? '?';
}

function displayName(c: SearchResultCandidate): string {
  const parts = [c.firstName, c.lastName].filter((v): v is string => Boolean(v && v.trim()));
  if (parts.length > 0) return parts.join(' ');
  return c.email ?? 'Unnamed candidate';
}

export function CandidateCard({
  candidate,
  highlighted = false,
}: {
  candidate: SearchResultCandidate;
  highlighted?: boolean;
}): JSX.Element {
  return (
    <Link
      href={`/candidates/${candidate.id}`}
      className={cn(
        'group flex items-start gap-4 rounded-lg border border-border bg-surface p-5 transition-all',
        'hover:-translate-y-0.5 hover:border-accent',
        highlighted && 'rounded-bl-xl',
      )}
    >
      <div
        aria-hidden
        className="flex h-12 w-12 shrink-0 items-center justify-center rounded-full bg-bg font-display text-sm font-semibold text-text-primary"
      >
        {initialsFor(candidate)}
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="truncate font-display text-base font-medium text-text-primary">
          {displayName(candidate)}
        </h3>
        {candidate.pitch ? (
          <p className="mt-1 line-clamp-2 text-sm text-text-muted">{candidate.pitch}</p>
        ) : (
          <p className="mt-1 text-sm italic text-text-muted">No pitch on file.</p>
        )}
        <div className="mt-3 flex flex-wrap items-center gap-3 text-xs text-text-muted">
          {candidate.email && <span className="font-mono">{candidate.email}</span>}
          {candidate.linkedinUrl && <span className="truncate">LinkedIn</span>}
        </div>
      </div>
    </Link>
  );
}
