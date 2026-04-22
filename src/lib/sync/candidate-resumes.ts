/**
 * Candidate-resume downloader (ADR-018).
 *
 * Teamtailor exposes two CV surfaces:
 *   - /v1/uploads → explicit recruiter/candidate uploads (handled
 *     by the uploads syncer).
 *   - candidates.attributes.resume → short-lived (~60s) S3 signed
 *     URL to a TT-generated PDF. For sourced candidates this is the
 *     ONLY CV artifact; for uploaded candidates it's typically a
 *     re-render of their upload.
 *
 * This module persists the latter as a `files` row with
 * `source='candidate_resume'`. The `teamtailor_id` is namespaced
 * with a `resume:` prefix so it cannot collide with numeric upload
 * ids (the uploads PK domain).
 *
 * URL expiration constraint: the signed URL in
 * `candidates.attributes.resume` is valid for ~60 seconds after TT
 * renders the JSON:API payload. The download MUST happen during the
 * same candidates sync pass — we can't reconstruct it later from
 * `candidates.raw_data`.
 *
 * All I/O is injected (`CandidateResumeDeps`) so unit tests run
 * without network or a live Supabase.
 */
import { downloadAndStore, type StorageBucketLike, type DownloadResult } from '../cv/downloader';

export interface CandidateResumeDeps {
  fetch: typeof fetch;
  storage: StorageBucketLike;
  randomUuid: () => string;
}

export interface CandidateResumeInput {
  candidate_tt_id: string;
  resume_url: string | null;
}

export interface CandidateResumeResult {
  /** Candidates with a non-empty resume URL that were processed. */
  attempted: number;
  /** Rows actually upserted into `files` (fresh binary or new). */
  upserted: number;
  /** Candidates skipped because `resume_url` was null/empty. */
  skippedNoUrl: number;
  /** Per-candidate failures (download error, unresolved local id). */
  errors: number;
}

interface DbLike {
  from(table: string): {
    select?: (cols: string) => {
      in: (
        col: string,
        ids: string[],
      ) => Promise<{
        data: Array<{ id: string; teamtailor_id: string; content_hash: string | null }> | null;
        error: { message: string } | null;
      }>;
    };
    upsert?: (
      rows: unknown[],
      opts?: { onConflict?: string },
    ) => Promise<{ error: { message: string } | null }>;
    insert?: (row: unknown) => Promise<{ error: { message: string } | null }>;
  };
}

/**
 * Namespaced teamtailor_id for resume-sourced files rows.
 * Prefixing with `resume:` avoids collisions with the numeric
 * uploads PK domain — `files.teamtailor_id` is UNIQUE.
 */
export function resumeTeamtailorId(candidateTtId: string): string {
  return `resume:${candidateTtId}`;
}

/**
 * Synthetic file name for resume binaries. TT doesn't expose a
 * `fileName` attribute on `candidates.attributes.resume`, but the
 * renderer always emits a PDF.
 */
export function resumeFileName(candidateTtId: string): string {
  return `resume-${candidateTtId}.pdf`;
}

async function recordDownloadError(
  db: DbLike,
  candidateTtId: string,
  err: unknown,
  runStartedAt: string,
): Promise<void> {
  const insert = db.from('sync_errors').insert;
  if (!insert) return;
  const { error } = await insert({
    entity: 'candidate_resumes',
    teamtailor_id: resumeTeamtailorId(candidateTtId),
    error_code: 'DownloadFailed',
    error_message: err instanceof Error ? err.message : String(err),
    payload: { candidate_tt_id: candidateTtId } as Record<string, unknown>,
    run_started_at: runStartedAt,
  });
  if (error) {
    // Best-effort: if sync_errors insert fails we still don't abort
    // the candidates batch. Emit a warning and continue.
    console.warn(
      `[candidate-resumes] failed to record sync_errors for ${candidateTtId}: ${error.message}`,
    );
  }
}

interface FileRow {
  teamtailor_id: string;
  candidate_id: string;
  storage_path: string;
  file_type: string;
  file_size_bytes: number;
  content_hash: string;
  is_internal: boolean;
  kind: string;
  source: 'candidate_resume';
  raw_data: unknown;
  parsed_text: null;
  parsed_at: null;
  parse_error: null;
}

export async function downloadResumesForCandidates(
  inputs: CandidateResumeInput[],
  candidateIdByTtId: Map<string, string>,
  db: DbLike,
  deps: CandidateResumeDeps,
): Promise<CandidateResumeResult> {
  const result: CandidateResumeResult = {
    attempted: 0,
    upserted: 0,
    skippedNoUrl: 0,
    errors: 0,
  };

  const withResume: CandidateResumeInput[] = [];
  for (const input of inputs) {
    if (typeof input.resume_url === 'string' && input.resume_url.length > 0) {
      withResume.push(input);
    } else {
      result.skippedNoUrl += 1;
    }
  }
  if (withResume.length === 0) return result;

  const ttIds = withResume.map((i) => resumeTeamtailorId(i.candidate_tt_id));
  const existingByTtId = new Map<string, { id: string; content_hash: string | null }>();
  const selectBuilder = db.from('files').select?.('id, teamtailor_id, content_hash');
  if (selectBuilder) {
    const { data, error } = await selectBuilder.in('teamtailor_id', ttIds);
    if (error) {
      throw new Error(`candidate-resumes: failed to load existing files: ${error.message}`);
    }
    for (const row of data ?? []) {
      existingByTtId.set(row.teamtailor_id, {
        id: row.id,
        content_hash: row.content_hash ?? null,
      });
    }
  }

  const runStartedAt = new Date().toISOString();
  const rows: FileRow[] = [];

  for (const input of withResume) {
    result.attempted += 1;
    const candidateId = candidateIdByTtId.get(input.candidate_tt_id);
    if (!candidateId) {
      // Defensive: the caller should have upserted candidates first.
      // Count as error but don't fetch — orphan candidate_tt_id is a
      // data-integrity signal, not a transient failure.
      result.errors += 1;
      continue;
    }
    const namespaced = resumeTeamtailorId(input.candidate_tt_id);
    const existing = existingByTtId.get(namespaced) ?? null;
    const fileUuid = existing?.id ?? deps.randomUuid();

    let download: DownloadResult;
    try {
      download = await downloadAndStore({
        url: input.resume_url as string,
        fileName: resumeFileName(input.candidate_tt_id),
        candidateId,
        fileUuid,
        existingHash: existing?.content_hash ?? null,
        deps: { fetch: deps.fetch, storage: deps.storage },
      });
    } catch (e) {
      result.errors += 1;
      await recordDownloadError(db, input.candidate_tt_id, e, runStartedAt);
      continue;
    }

    if (!download.uploadedFresh) {
      // Binary unchanged — leave files row as-is, no parser invalidation.
      continue;
    }

    rows.push({
      teamtailor_id: namespaced,
      candidate_id: candidateId,
      storage_path: download.storagePath,
      file_type: download.fileType,
      file_size_bytes: download.fileSizeBytes,
      content_hash: download.contentHash,
      is_internal: false,
      kind: 'cv',
      source: 'candidate_resume',
      raw_data: { candidate_tt_id: input.candidate_tt_id, source: 'candidate_resume' },
      parsed_text: null,
      parsed_at: null,
      parse_error: null,
    });
  }

  if (rows.length === 0) return result;

  const upsert = db.from('files').upsert;
  if (!upsert) {
    throw new Error('candidate-resumes: db.from(files).upsert is unavailable');
  }
  const { error: upErr } = await upsert(rows, { onConflict: 'teamtailor_id' });
  if (upErr) {
    throw new Error(`candidate-resumes: files upsert failed: ${upErr.message}`);
  }
  result.upserted = rows.length;
  return result;
}
