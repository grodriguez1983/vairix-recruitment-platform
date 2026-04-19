/**
 * "Planilla VAIRIX" section of the candidate profile.
 *
 * The planilla is a per-candidate spreadsheet that historically lived
 * in a Teamtailor custom-question answer (`question_tt_id=24016`,
 * holding a Google Sheets URL) and that recruiters also upload
 * directly to Storage as a rendered PDF/XLSX. We surface both here:
 *
 *   - `url`: the TT link, taken from the most-recent non-null
 *     `evaluation_answers.value_text` for question 24016.
 *   - `uploadedFileId` / `uploadedFileName`: the non-soft-deleted
 *     `files` row with `kind='vairix_cv_sheet'` (at most one per
 *     candidate due to the partial unique index).
 *
 * Admin users get the manual-upload form at the bottom of the card.
 */
import type { createClient } from '@/lib/supabase/server';

import { fileNameFromRow } from './cvs-section';
import { OpenFileButton } from './open-file-button';
import { VairixSheetUpload } from './vairix-sheet-upload';

export interface VairixSheetData {
  url: string | null;
  uploadedFileId: string | null;
  uploadedFileName: string | null;
}

export async function fetchVairixSheet(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<VairixSheetData> {
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
    .select('id, storage_path, raw_data')
    .eq('candidate_id', candidateId)
    .eq('kind', 'vairix_cv_sheet')
    .is('deleted_at', null)
    .limit(1);
  const sheet = (files ?? [])[0] as
    | { id: string; storage_path: string; raw_data: Record<string, unknown> | null }
    | undefined;
  const uploadedFileId = sheet?.id ?? null;
  const uploadedFileName = sheet
    ? fileNameFromRow({ storage_path: sheet.storage_path, raw_data: sheet.raw_data })
    : null;

  return { url, uploadedFileId, uploadedFileName };
}

export function VairixSheetSection({
  sheet,
  candidateId,
  canUpload,
}: {
  sheet: VairixSheetData;
  candidateId: string;
  canUpload: boolean;
}): JSX.Element {
  const hasAny = Boolean(sheet.url || sheet.uploadedFileName);
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
        Planilla VAIRIX
      </h2>
      <div className="rounded-lg border border-border bg-surface p-5">
        {hasAny ? (
          <dl className="flex flex-col gap-3 text-sm">
            {sheet.url && (
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-xs text-text-muted">Link (Teamtailor)</dt>
                <dd className="break-words">
                  <a
                    href={sheet.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="font-mono text-xs text-accent hover:underline underline-offset-4"
                  >
                    {sheet.url} ↗
                  </a>
                </dd>
              </div>
            )}
            {sheet.uploadedFileName && (
              <div className="flex min-w-0 flex-col gap-1">
                <dt className="text-xs text-text-muted">Archivo subido</dt>
                <dd className="flex flex-wrap items-center gap-3">
                  <span className="break-words font-mono text-xs text-text-primary">
                    {sheet.uploadedFileName}
                  </span>
                  {sheet.uploadedFileId && (
                    <OpenFileButton fileId={sheet.uploadedFileId} label="Abrir" />
                  )}
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
        {canUpload && <VairixSheetUpload candidateId={candidateId} />}
      </div>
    </section>
  );
}
