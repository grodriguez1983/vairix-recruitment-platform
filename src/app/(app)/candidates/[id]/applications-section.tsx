/**
 * "Applications" section of the candidate profile.
 *
 * Lists every application row for the candidate, newest first, with
 * the job title, stage, status badge, and dates for applied /
 * rejected / hired. RLS on `applications` already governs visibility.
 */
import type { createClient } from '@/lib/supabase/server';

export interface ApplicationWithJob {
  id: string;
  status: string | null;
  stage_name: string | null;
  created_at: string;
  rejected_at: string | null;
  hired_at: string | null;
  jobs: { id: string; title: string } | null;
}

export async function fetchApplications(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<ApplicationWithJob[]> {
  const { data } = await supabase
    .from('applications')
    .select('id, status, stage_name, created_at, rejected_at, hired_at, jobs(id, title)')
    .eq('candidate_id', candidateId)
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as ApplicationWithJob[];
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

export function ApplicationsSection({
  applications,
}: {
  applications: ApplicationWithJob[];
}): JSX.Element {
  return (
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
  );
}
