/**
 * Candidate profile header — avatar + name + pitch + contact chips.
 *
 * Pure presentational; the calling page still owns the candidate
 * fetch and RLS checks.
 */
export interface CandidateHeaderData {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  pitch: string | null;
  updated_at: string;
}

function displayName(c: CandidateHeaderData): string {
  const parts = [c.first_name, c.last_name].filter((v): v is string => Boolean(v && v.trim()));
  if (parts.length > 0) return parts.join(' ');
  return c.email ?? 'Unnamed candidate';
}

function initialsFor(c: CandidateHeaderData): string {
  const first = c.first_name?.trim().charAt(0) ?? '';
  const last = c.last_name?.trim().charAt(0) ?? '';
  const combined = `${first}${last}`.toUpperCase();
  if (combined.length > 0) return combined;
  return c.email?.trim().charAt(0).toUpperCase() ?? '?';
}

function formatDate(iso: string | null): string | null {
  if (!iso) return null;
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function ProfileHeader({ c }: { c: CandidateHeaderData }): JSX.Element {
  return (
    <header className="mb-8 flex items-start gap-5 rounded-lg border border-border bg-surface p-6">
      <div
        aria-hidden
        className="flex h-16 w-16 shrink-0 items-center justify-center rounded-full bg-bg font-display text-lg font-semibold text-text-primary"
      >
        {initialsFor(c)}
      </div>
      <div className="min-w-0 flex-1">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          {displayName(c)}
        </h1>
        {c.pitch && <p className="mt-2 text-sm text-text-muted">{c.pitch}</p>}
        <dl className="mt-4 grid gap-x-6 gap-y-1 text-xs sm:grid-cols-2">
          {c.email && (
            <div className="flex gap-2">
              <dt className="text-text-muted">Email</dt>
              <dd className="font-mono text-text-primary">{c.email}</dd>
            </div>
          )}
          {c.phone && (
            <div className="flex gap-2">
              <dt className="text-text-muted">Phone</dt>
              <dd className="font-mono text-text-primary">{c.phone}</dd>
            </div>
          )}
          {c.linkedin_url && (
            <div className="flex gap-2">
              <dt className="text-text-muted">LinkedIn</dt>
              <dd>
                <a
                  href={c.linkedin_url}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="text-accent hover:underline underline-offset-4"
                >
                  Profile ↗
                </a>
              </dd>
            </div>
          )}
          <div className="flex gap-2">
            <dt className="text-text-muted">Synced</dt>
            <dd className="text-text-primary">{formatDate(c.updated_at)}</dd>
          </div>
        </dl>
      </div>
    </header>
  );
}
