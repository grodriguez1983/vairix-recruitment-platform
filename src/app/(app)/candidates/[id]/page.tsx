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
import { listActiveShortlists } from '@/lib/shortlists/service';
import { createClient } from '@/lib/supabase/server';
import { listTagsForCandidate, listAllTagNames } from '@/lib/tags/service';

import { AddToShortlist } from './add-to-shortlist';
import { CandidateTags } from './candidate-tags';

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

interface VairixSheetData {
  url: string | null;
  uploadedFileName: string | null;
}

async function fetchVairixSheet(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<VairixSheetData> {
  // TT URL: latest non-null answer to custom question 24016 on this
  // candidate's interviews.
  const { data: evals } = await supabase
    .from('evaluations')
    .select('id')
    .eq('candidate_id', candidateId);
  const evalIds = (evals ?? [])
    .map((e) => (e as { id: string | null }).id)
    .filter((v): v is string => typeof v === 'string');

  let url: string | null = null;
  if (evalIds.length > 0) {
    const { data: answers } = await supabase
      .from('evaluation_answers')
      .select('value_text, updated_at')
      .eq('question_tt_id', '24016')
      .in('evaluation_id', evalIds)
      .not('value_text', 'is', null)
      .order('updated_at', { ascending: false })
      .limit(1);
    const first = (answers ?? [])[0] as { value_text: string | null } | undefined;
    url = first?.value_text ?? null;
  }

  const { data: files } = await supabase
    .from('files')
    .select('storage_path')
    .eq('candidate_id', candidateId)
    .eq('kind', 'vairix_cv_sheet')
    .is('deleted_at', null)
    .limit(1);
  const uploadedFileName =
    ((files ?? [])[0] as { storage_path: string | null } | undefined)?.storage_path ?? null;

  return { url, uploadedFileName };
}

interface CustomFieldValueRow {
  id: string;
  field_type: string;
  value_text: string | null;
  value_date: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  raw_value: string | null;
  custom_fields: {
    name: string;
    api_name: string;
    is_private: boolean;
  } | null;
}

function displayValue(v: CustomFieldValueRow): string {
  switch (v.field_type) {
    case 'CustomField::Text':
      return v.value_text ?? v.raw_value ?? '';
    case 'CustomField::Date':
      return v.value_date ?? v.raw_value ?? '';
    case 'CustomField::Number':
      return v.value_number?.toString() ?? v.raw_value ?? '';
    case 'CustomField::Boolean':
      if (v.value_boolean === true) return 'Yes';
      if (v.value_boolean === false) return 'No';
      return v.raw_value ?? '';
    default:
      return v.raw_value ?? '';
  }
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

  const { data: valuesData } = await supabase
    .from('candidate_custom_field_values')
    .select(
      'id, field_type, value_text, value_date, value_number, value_boolean, raw_value, custom_fields(name, api_name, is_private)',
    )
    .eq('candidate_id', c.id);

  const customFieldValues = ((valuesData ?? []) as unknown as CustomFieldValueRow[])
    .filter((v) => v.custom_fields !== null)
    .sort((a, b) => (a.custom_fields?.name ?? '').localeCompare(b.custom_fields?.name ?? ''));

  const [tags, allTagNames, activeShortlists, vairixSheet] = await Promise.all([
    listTagsForCandidate(supabase, c.id).catch(() => []),
    listAllTagNames(supabase).catch(() => [] as string[]),
    listActiveShortlists(supabase).catch(() => []),
    fetchVairixSheet(supabase, c.id).catch(
      () => ({ url: null, uploadedFileName: null }) as VairixSheetData,
    ),
  ]);

  const shortlistOptions = activeShortlists.map((sl) => ({ id: sl.id, name: sl.name }));

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

      {customFieldValues.length > 0 && (
        <section className="mb-6">
          <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
            Metadata VAIRIX{' '}
            <span className="font-mono text-xs font-normal text-text-muted">
              ({customFieldValues.length})
            </span>
          </h2>
          <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
            {customFieldValues.map((v) => (
              <div key={v.id} className="flex min-w-0 flex-col gap-0.5">
                <dt className="flex items-center gap-2 text-xs text-text-muted">
                  {v.custom_fields?.name ?? v.custom_fields?.api_name ?? '—'}
                  {v.custom_fields?.is_private && (
                    <span
                      title="Private field"
                      className="rounded-sm bg-warning/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-widest text-warning"
                    >
                      private
                    </span>
                  )}
                </dt>
                <dd className="break-words font-mono text-sm text-text-primary">
                  {displayValue(v) || <span className="italic text-text-muted">—</span>}
                </dd>
              </div>
            ))}
          </dl>
        </section>
      )}

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

      <section className="mb-6">
        <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
          Planilla VAIRIX
        </h2>
        <div className="rounded-lg border border-border bg-surface p-5">
          {vairixSheet.url || vairixSheet.uploadedFileName ? (
            <dl className="flex flex-col gap-3 text-sm">
              {vairixSheet.url && (
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs text-text-muted">Link (Teamtailor)</dt>
                  <dd className="break-words">
                    <a
                      href={vairixSheet.url}
                      target="_blank"
                      rel="noreferrer noopener"
                      className="font-mono text-xs text-accent hover:underline underline-offset-4"
                    >
                      {vairixSheet.url} ↗
                    </a>
                  </dd>
                </div>
              )}
              {vairixSheet.uploadedFileName && (
                <div className="flex min-w-0 flex-col gap-1">
                  <dt className="text-xs text-text-muted">Archivo subido</dt>
                  <dd className="break-words font-mono text-xs text-text-primary">
                    {vairixSheet.uploadedFileName}
                  </dd>
                </div>
              )}
            </dl>
          ) : (
            <p className="text-sm text-text-muted">
              Sin planilla VAIRIX asociada. Esperá a la sincronización con Teamtailor o subí el
              archivo manualmente.
            </p>
          )}
          <p className="mt-4 border-t border-border pt-3 text-xs text-text-muted">
            Carga manual disponible en F1-007 (bucket de Storage).
          </p>
        </div>
      </section>

      <CandidateTags candidateId={c.id} initialTags={tags} allTagNames={allTagNames} />

      <AddToShortlist candidateId={c.id} shortlists={shortlistOptions} />

      <section className="rounded-lg border border-border border-dashed bg-surface p-6">
        <h2 className="font-display text-base font-semibold text-text-primary">More coming soon</h2>
        <p className="mt-2 text-sm text-text-muted">
          CV viewer, evaluations, and notes land with F1-011 full. See{' '}
          <code className="font-mono text-xs">docs/roadmap.md</code>.
        </p>
      </section>
    </div>
  );
}
