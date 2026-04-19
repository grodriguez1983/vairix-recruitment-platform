/**
 * "Currículums" section of the candidate profile.
 *
 * Renders every non-soft-deleted `files` row with `kind='cv'` for the
 * candidate. Each row exposes an `OpenFileButton` that mints a
 * short-lived signed URL on click. The row also surfaces the current
 * parse status (pending / parse error) so a recruiter spotting a
 * broken CV can open it and diagnose without jumping to SQL.
 *
 * The fetch is colocated here (not on the page) so the page orchestrator
 * stays thin — it still controls the parallel Promise.all shape via the
 * exported `fetchCvFiles`.
 */
import type { createClient } from '@/lib/supabase/server';

import { OpenFileButton } from './open-file-button';

export interface CvFileRow {
  id: string;
  storage_path: string;
  file_type: string;
  parsed_text: string | null;
  parse_error: string | null;
  raw_data: Record<string, unknown> | null;
  created_at: string;
}

export function fileNameFromRow(row: {
  storage_path: string;
  raw_data: Record<string, unknown> | null;
}): string {
  const raw = (row.raw_data ?? {}) as Record<string, unknown>;
  const attrs = ((raw['attributes'] as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const fromManual = raw['originalFileName'];
  if (typeof fromManual === 'string' && fromManual.length > 0) return fromManual;
  const fromTt = attrs['fileName'];
  if (typeof fromTt === 'string' && fromTt.length > 0) return fromTt;
  return row.storage_path.split('/').pop() ?? row.storage_path;
}

export async function fetchCvFiles(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<CvFileRow[]> {
  const { data } = await supabase
    .from('files')
    .select('id, storage_path, file_type, parsed_text, parse_error, raw_data, created_at')
    .eq('candidate_id', candidateId)
    .eq('kind', 'cv')
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as CvFileRow[];
}

function formatDate(iso: string): string | null {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

export function CvsSection({ files }: { files: CvFileRow[] }): JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
        Currículums{' '}
        <span className="font-mono text-xs font-normal text-text-muted">({files.length})</span>
      </h2>
      {files.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-6 text-center">
          <p className="text-sm text-text-muted">
            Sin CVs cargados. Se sincronizan automáticamente desde Teamtailor.
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {files.map((f) => {
            const name = fileNameFromRow(f);
            return (
              <li
                key={f.id}
                className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4"
              >
                <div className="min-w-0 flex-1">
                  <p className="break-words font-mono text-sm text-text-primary">{name}</p>
                  <p className="mt-0.5 text-xs text-text-muted">
                    {f.file_type} · cargado {formatDate(f.created_at)}
                    {f.parse_error && (
                      <span className="ml-2 text-danger">· parse error: {f.parse_error}</span>
                    )}
                    {!f.parse_error && f.parsed_text === null && (
                      <span className="ml-2 text-warning">· pending parse</span>
                    )}
                  </p>
                </div>
                <OpenFileButton fileId={f.id} label="Abrir" />
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
