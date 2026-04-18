/**
 * `/candidates/[id]` — consolidated candidate profile (UC-04).
 *
 * F1-011a scope: identity header + applications list only. The full
 * profile (CV viewer, evaluations, notes, tags) lands in F1-011 once
 * those syncers and the CV pipeline exist. The page is intentionally
 * thin so that F1-011 can extend it in place without restructuring.
 *
 * RLS does the heavy lifting: recruiters never reach rows with
 * `deleted_at IS NOT NULL`, so a 404 here can mean the candidate
 * never existed OR was soft-deleted — both are "not visible" from
 * the recruiter's perspective.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAuth } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: { id: string };
}

interface CandidateRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  pitch: string | null;
  created_at: string;
  updated_at: string;
}

interface ApplicationWithJob {
  id: string;
  status: string | null;
  stage_name: string | null;
  created_at: string;
  rejected_at: string | null;
  hired_at: string | null;
  jobs: { id: string; title: string } | null;
}

function displayName(c: CandidateRow): string {
  const parts = [c.first_name, c.last_name].filter((v): v is string => Boolean(v && v.trim()));
  if (parts.length > 0) return parts.join(' ');
  return c.email ?? 'Unnamed candidate';
}

function initialsFor(c: CandidateRow): string {
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

function statusBadgeClass(status: string | null): string {
  switch (status) {
    case 'active':
      return 'bg-info/10 text-info';
    case 'hired':
      return 'bg-accent/10 text-accent';
    case 'rejected':
      return 'bg-danger/10 text-danger';
    case 'withdrawn':
      return 'bg-warning/10 text-warning';
    default:
      return 'bg-border text-text-muted';
  }
}

export async function generateMetadata({ params }: PageProps): Promise<{ title: string }> {
  return { title: `Candidate ${params.id.slice(0, 8)} — Recruitment Data Platform` };
}

export default async function CandidateProfilePage({ params }: PageProps): Promise<JSX.Element> {
  await requireAuth();

  if (!UUID_REGEX.test(params.id)) {
    notFound();
  }

  const supabase = createClient();
  const { data: candidate } = await supabase
    .from('candidates')
    .select('id, first_name, last_name, email, phone, linkedin_url, pitch, created_at, updated_at')
    .eq('id', params.id)
    .maybeSingle();

  if (!candidate) {
    notFound();
  }

  const c = candidate as CandidateRow;

  const { data: appsData } = await supabase
    .from('applications')
    .select('id, status, stage_name, created_at, rejected_at, hired_at, jobs(id, title)')
    .eq('candidate_id', c.id)
    .order('created_at', { ascending: false });

  const applications = (appsData ?? []) as unknown as ApplicationWithJob[];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link
          href="/candidates"
          className="text-xs font-medium text-text-muted hover:text-text-primary"
        >
          ← Back to candidates
        </Link>
      </div>

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

      <section className="mb-6">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
          Applications{' '}
          <span className="font-mono text-xs font-normal text-text-muted">
            ({applications.length})
          </span>
        </h2>
        {applications.length === 0 ? (
          <div className="rounded-lg border border-border border-dashed bg-surface p-6 text-center">
            <p className="text-sm text-text-muted">No applications on file.</p>
          </div>
        ) : (
          <ul className="flex flex-col gap-2">
            {applications.map((app) => (
              <li
                key={app.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="font-display text-sm font-medium text-text-primary">
                    {app.jobs?.title ?? <span className="italic text-text-muted">Unknown job</span>}
                  </p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {app.stage_name ?? '—'} · applied {formatDate(app.created_at)}
                    {app.rejected_at && ` · rejected ${formatDate(app.rejected_at)}`}
                    {app.hired_at && ` · hired ${formatDate(app.hired_at)}`}
                  </p>
                </div>
                <span
                  className={`inline-flex h-6 items-center rounded-sm px-2 font-mono text-[10px] uppercase tracking-widest ${statusBadgeClass(app.status)}`}
                >
                  {app.status ?? 'unknown'}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border border-border border-dashed bg-surface p-6">
        <h2 className="font-display text-base font-semibold text-text-primary">More coming soon</h2>
        <p className="mt-2 text-sm text-text-muted">
          CV viewer, evaluations, notes, and tags land with F1-011 full. See{' '}
          <code className="font-mono text-xs">docs/roadmap.md</code>.
        </p>
      </section>
    </div>
  );
}
