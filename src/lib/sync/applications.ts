/**
 * Applications syncer (Teamtailor `job-applications`).
 *
 * This is the first syncer that reconciles foreign keys: TT gives us
 * `relationships.candidate.data.id` etc. as teamtailor IDs, but the
 * local `applications` table references `candidates.id`, `jobs.id`,
 * `stages.id` (local UUIDs). The mapping is resolved inside
 * `upsert()` via a single lookup per parent table.
 *
 * Orphan handling: if `candidate_id` cannot be resolved, the row is
 * logged to `sync_errors` (candidate_id is NOT NULL in the schema)
 * and skipped. Unresolved job/stage degrade gracefully to null
 * because those FKs are nullable.
 *
 * Attribute key normalization: parseDocument returns camelCased
 * attributes, so `cover-letter` → `coverLetter`, `rejected-at` →
 * `rejectedAt`, `hired-at` → `hiredAt`.
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';
import { ParseError } from '../teamtailor/errors';

const ALLOWED_STATUSES = new Set(['active', 'rejected', 'hired', 'withdrawn']);

export interface ApplicationStaging {
  teamtailor_id: string;
  candidate_tt_id: string;
  job_tt_id: string | null;
  stage_tt_id: string | null;
  status: string | null;
  source: string | null;
  cover_letter: string | null;
  rejected_at: string | null;
  hired_at: string | null;
  raw_data: unknown;
}

function optionalString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function normalizeStatus(attrs: Record<string, unknown>): string | null {
  const raw = attrs['status'];
  if (typeof raw !== 'string') return null;
  return ALLOWED_STATUSES.has(raw) ? raw : null;
}

function relId(resource: TTParsedResource, relation: string): string | null {
  const rel = resource.relationships?.[relation];
  if (!rel || !rel.data || Array.isArray(rel.data)) return null;
  return rel.data.id;
}

async function buildIdMap(
  deps: SyncerDeps,
  table: 'candidates' | 'jobs' | 'stages',
  ttIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ttIds.length === 0) return map;
  const { data, error } = await deps.db
    .from(table)
    .select('id, teamtailor_id')
    .in('teamtailor_id', ttIds);
  if (error) {
    throw new SyncError(`applications: failed to resolve ${table} FKs`, {
      cause: error.message,
      count: ttIds.length,
    });
  }
  for (const row of data ?? []) map.set(row.teamtailor_id as string, row.id as string);
  return map;
}

async function recordOrphan(
  deps: SyncerDeps,
  staging: ApplicationStaging,
  missing: string,
): Promise<void> {
  const { error } = await deps.db.from('sync_errors').insert({
    entity: 'applications',
    teamtailor_id: staging.teamtailor_id,
    error_code: 'OrphanFK',
    error_message: `applications[${staging.teamtailor_id}]: unresolved ${missing} tt_id=${
      missing === 'candidate' ? staging.candidate_tt_id : '(n/a)'
    }`,
    payload: staging.raw_data as Record<string, unknown>,
    run_started_at: new Date().toISOString(),
  });
  if (error) {
    throw new SyncError('applications: failed to record orphan in sync_errors', {
      cause: error.message,
      teamtailorId: staging.teamtailor_id,
    });
  }
}

export const applicationsSyncer: EntitySyncer<ApplicationStaging> = {
  entity: 'applications',

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = { 'page[size]': '30' };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/job-applications', params };
  },

  mapResource(resource: TTParsedResource): ApplicationStaging {
    const attrs = resource.attributes;
    const candidateTtId = relId(resource, 'candidate');
    if (!candidateTtId) {
      // No candidate relationship at all — mapResource throws so the
      // runner records a row-level error in sync_errors.
      throw new ParseError(
        `applications[${resource.id}]: missing required relationship "candidate"`,
        { teamtailorId: resource.id },
      );
    }
    return {
      teamtailor_id: resource.id,
      candidate_tt_id: candidateTtId,
      job_tt_id: relId(resource, 'job'),
      stage_tt_id: relId(resource, 'stage'),
      status: normalizeStatus(attrs),
      source: optionalString(attrs, 'source'),
      cover_letter: optionalString(attrs, 'coverLetter'),
      rejected_at: optionalString(attrs, 'rejectedAt'),
      hired_at: optionalString(attrs, 'hiredAt'),
      raw_data: resource,
    };
  },

  async upsert(stagings: ApplicationStaging[], deps: SyncerDeps): Promise<number> {
    if (stagings.length === 0) return 0;

    const candidateIds = Array.from(new Set(stagings.map((s) => s.candidate_tt_id)));
    const jobIds = Array.from(
      new Set(stagings.map((s) => s.job_tt_id).filter((v): v is string => v !== null)),
    );
    const stageIds = Array.from(
      new Set(stagings.map((s) => s.stage_tt_id).filter((v): v is string => v !== null)),
    );

    const [candidateMap, jobMap, stageMap] = await Promise.all([
      buildIdMap(deps, 'candidates', candidateIds),
      buildIdMap(deps, 'jobs', jobIds),
      buildIdMap(deps, 'stages', stageIds),
    ]);

    const rows: Array<{
      teamtailor_id: string;
      candidate_id: string;
      job_id: string | null;
      stage_id: string | null;
      status: string | null;
      source: string | null;
      cover_letter: string | null;
      rejected_at: string | null;
      hired_at: string | null;
      raw_data: unknown;
    }> = [];

    for (const s of stagings) {
      const candidateId = candidateMap.get(s.candidate_tt_id);
      if (!candidateId) {
        await recordOrphan(deps, s, 'candidate');
        continue;
      }
      rows.push({
        teamtailor_id: s.teamtailor_id,
        candidate_id: candidateId,
        job_id: s.job_tt_id ? (jobMap.get(s.job_tt_id) ?? null) : null,
        stage_id: s.stage_tt_id ? (stageMap.get(s.stage_tt_id) ?? null) : null,
        status: s.status,
        source: s.source,
        cover_letter: s.cover_letter,
        rejected_at: s.rejected_at,
        hired_at: s.hired_at,
        raw_data: s.raw_data,
      });
    }

    if (rows.length === 0) return 0;
    const { error } = await deps.db
      .from('applications')
      .upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('applications upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
