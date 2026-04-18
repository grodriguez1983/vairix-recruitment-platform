/**
 * Uploads syncer (Teamtailor `/v1/uploads` → `files`).
 *
 * Per upload we:
 *   1. Look up the existing `files` row (by teamtailor_id) to
 *      carry over the previous `content_hash` — lets us skip
 *      re-uploading unchanged binaries (ADR-006 §2).
 *   2. Ask the downloader to fetch + hash + (conditionally) upload
 *      the binary to the `candidate-cvs` bucket.
 *   3. Upsert a `files` row. When the binary changed we also
 *      invalidate parser state (`parsed_text`, `parsed_at`,
 *      `parse_error` → null) so the CV parser reprocesses it.
 *
 * FK reconciliation:
 *   - `candidate` → files.candidate_id (REQUIRED; orphan → sync_errors).
 *
 * Sideload: `?include=candidate` populates relationships.candidate.data
 * with `{ type: 'candidates', id }` (see teamtailor-api-notes §5.7).
 *
 * This syncer is exported via a factory (`makeUploadsSyncer`) so
 * tests can inject a fake Storage bucket + fetch. The default
 * production build uses `deps.db.storage.from(BUCKET)` + global fetch,
 * via `uploadsSyncer()` in sync-incremental.ts.
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';
import { ParseError } from '../teamtailor/errors';
import { downloadAndStore, type StorageBucketLike, type DownloadResult } from '../cv/downloader';

export interface UploadStaging {
  teamtailor_id: string;
  candidate_tt_id: string;
  url: string;
  file_name: string;
  is_internal: boolean;
  raw_data: unknown;
}

export interface UploadsSyncerFactoryDeps {
  /** Bucket client — typically `supabaseServiceClient.storage.from('candidate-cvs')`. */
  storage: StorageBucketLike;
  /** Fetch impl. Defaults to `globalThis.fetch`. Injected in tests. */
  fetch?: typeof fetch;
  /** UUID generator for new rows. Defaults to `crypto.randomUUID`. Injected in tests. */
  randomUuid?: () => string;
}

function relId(resource: TTParsedResource, relation: string): string | null {
  const rel = resource.relationships?.[relation];
  if (!rel || !rel.data || Array.isArray(rel.data)) return null;
  return rel.data.id;
}

function requiredString(attrs: Record<string, unknown>, key: string): string {
  const v = attrs[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ParseError(`uploads: missing required attribute "${key}"`);
  }
  return v;
}

async function buildCandidateMap(deps: SyncerDeps, ttIds: string[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ttIds.length === 0) return map;
  const { data, error } = await deps.db
    .from('candidates')
    .select('id, teamtailor_id')
    .in('teamtailor_id', ttIds);
  if (error) {
    throw new SyncError('uploads: failed to resolve candidates FKs', {
      cause: error.message,
      count: ttIds.length,
    });
  }
  for (const row of data ?? []) map.set(row.teamtailor_id as string, row.id as string);
  return map;
}

async function loadExistingFiles(
  deps: SyncerDeps,
  ttIds: string[],
): Promise<Map<string, { id: string; content_hash: string | null }>> {
  const out = new Map<string, { id: string; content_hash: string | null }>();
  if (ttIds.length === 0) return out;
  const { data, error } = await deps.db
    .from('files')
    .select('id, teamtailor_id, content_hash')
    .in('teamtailor_id', ttIds);
  if (error) {
    throw new SyncError('uploads: failed to load existing files', {
      cause: error.message,
      count: ttIds.length,
    });
  }
  for (const row of data ?? []) {
    out.set(row.teamtailor_id as string, {
      id: row.id as string,
      content_hash: (row.content_hash as string | null) ?? null,
    });
  }
  return out;
}

async function recordOrphan(deps: SyncerDeps, staging: UploadStaging): Promise<void> {
  const { error } = await deps.db.from('sync_errors').insert({
    entity: 'uploads',
    teamtailor_id: staging.teamtailor_id,
    error_code: 'OrphanFK',
    error_message: `uploads[${staging.teamtailor_id}]: unresolved candidate tt_id=${staging.candidate_tt_id}`,
    payload: staging.raw_data as Record<string, unknown>,
    run_started_at: new Date().toISOString(),
  });
  if (error) {
    throw new SyncError('uploads: failed to record orphan in sync_errors', {
      cause: error.message,
      teamtailorId: staging.teamtailor_id,
    });
  }
}

export function makeUploadsSyncer(
  factoryDeps: UploadsSyncerFactoryDeps,
): EntitySyncer<UploadStaging> {
  const fetchImpl = factoryDeps.fetch ?? globalThis.fetch.bind(globalThis);
  const randomUuid = factoryDeps.randomUuid ?? (() => globalThis.crypto.randomUUID());

  return {
    // sync_state key — matches the 'files' row seeded in migration 008.
    // The TT endpoint is /v1/uploads but our downstream table is files.
    entity: 'files',

    buildInitialRequest(cursor: string | null) {
      const params: Record<string, string> = {
        'page[size]': '30',
        include: 'candidate',
      };
      if (cursor) params['filter[updated-at][from]'] = cursor;
      return { path: '/uploads', params };
    },

    mapResource(resource: TTParsedResource): UploadStaging {
      const attrs = resource.attributes;
      const candidateTtId = relId(resource, 'candidate');
      if (!candidateTtId) {
        throw new ParseError(`uploads[${resource.id}]: missing required relationship "candidate"`, {
          teamtailorId: resource.id,
        });
      }
      const url = requiredString(attrs, 'url');
      const fileName = requiredString(attrs, 'fileName');
      const internal = attrs['internal'];
      return {
        teamtailor_id: resource.id,
        candidate_tt_id: candidateTtId,
        url,
        file_name: fileName,
        is_internal: typeof internal === 'boolean' ? internal : false,
        raw_data: resource,
      };
    },

    async upsert(stagings: UploadStaging[], deps: SyncerDeps): Promise<number> {
      if (stagings.length === 0) return 0;

      const candidateTtIds = Array.from(new Set(stagings.map((s) => s.candidate_tt_id)));
      const uploadTtIds = stagings.map((s) => s.teamtailor_id);

      const [candidateMap, existingByTtId] = await Promise.all([
        buildCandidateMap(deps, candidateTtIds),
        loadExistingFiles(deps, uploadTtIds),
      ]);

      type FileRow = {
        teamtailor_id: string;
        candidate_id: string;
        storage_path: string;
        file_type: string;
        file_size_bytes: number;
        content_hash: string;
        is_internal: boolean;
        kind: string;
        raw_data: unknown;
        parsed_text: null;
        parsed_at: null;
        parse_error: null;
      };
      const rows: FileRow[] = [];
      let upserted = 0;

      for (const s of stagings) {
        const candidateId = candidateMap.get(s.candidate_tt_id);
        if (!candidateId) {
          await recordOrphan(deps, s);
          continue;
        }
        const existing = existingByTtId.get(s.teamtailor_id) ?? null;
        const fileUuid = existing?.id ?? randomUuid();

        let download: DownloadResult;
        try {
          download = await downloadAndStore({
            url: s.url,
            fileName: s.file_name,
            candidateId,
            fileUuid,
            existingHash: existing?.content_hash ?? null,
            deps: { fetch: fetchImpl, storage: factoryDeps.storage },
          });
        } catch (e) {
          // Download failure for a single upload is row-level: don't
          // abort the batch, log and move on.
          const { error: syncErr } = await deps.db.from('sync_errors').insert({
            entity: 'uploads',
            teamtailor_id: s.teamtailor_id,
            error_code: 'DownloadFailed',
            error_message: e instanceof Error ? e.message : String(e),
            payload: s.raw_data as Record<string, unknown>,
            run_started_at: new Date().toISOString(),
          });
          if (syncErr) {
            throw new SyncError('uploads: failed to record download error', {
              cause: syncErr.message,
              teamtailorId: s.teamtailor_id,
            });
          }
          continue;
        }

        if (!download.uploadedFresh) {
          // Binary unchanged — leave the files row alone (don't bump
          // synced_at, don't invalidate parsed_text).
          continue;
        }

        rows.push({
          teamtailor_id: s.teamtailor_id,
          candidate_id: candidateId,
          storage_path: download.storagePath,
          file_type: download.fileType,
          file_size_bytes: download.fileSizeBytes,
          content_hash: download.contentHash,
          is_internal: s.is_internal,
          kind: 'cv',
          raw_data: s.raw_data,
          parsed_text: null,
          parsed_at: null,
          parse_error: null,
        });
      }

      if (rows.length === 0) return 0;

      const { error } = await deps.db.from('files').upsert(rows, { onConflict: 'teamtailor_id' });
      if (error) {
        throw new SyncError('uploads: files upsert failed', {
          cause: error.message,
          count: rows.length,
        });
      }
      upserted += rows.length;
      return upserted;
    },
  };
}
