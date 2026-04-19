/**
 * Notes syncer (Teamtailor `/v1/notes`).
 *
 * FK reconciliation:
 *   - `candidate` → candidates.id (REQUIRED; orphan → sync_errors).
 *   - `job-application` → applications.id (optional; unresolved → null).
 *   - `user` → users.id (optional; unresolved → null).
 *
 * Row-level validation: empty body (NOT NULL in schema) → row error.
 *
 * Attribute key normalization: parseDocument returns camelCased
 * attributes, so `created-at` → `createdAt`. TT exposes the note
 * content under the `note` attribute (not `body`); we map it to
 * `body` (the local column name).
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';
import { ParseError } from '../teamtailor/errors';

export interface NoteStaging {
  teamtailor_id: string;
  candidate_tt_id: string;
  application_tt_id: string | null;
  user_tt_id: string | null;
  body: string;
  raw_data: unknown;
}

function relId(resource: TTParsedResource, relation: string): string | null {
  const rel = resource.relationships?.[relation];
  if (!rel || !rel.data || Array.isArray(rel.data)) return null;
  return rel.data.id;
}

async function buildIdMap(
  deps: SyncerDeps,
  table: 'candidates' | 'applications' | 'users',
  ttIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ttIds.length === 0) return map;
  const { data, error } = await deps.db
    .from(table)
    .select('id, teamtailor_id')
    .in('teamtailor_id', ttIds);
  if (error) {
    throw new SyncError(`notes: failed to resolve ${table} FKs`, {
      cause: error.message,
      count: ttIds.length,
    });
  }
  for (const row of data ?? []) map.set(row.teamtailor_id as string, row.id as string);
  return map;
}

async function recordOrphan(deps: SyncerDeps, staging: NoteStaging): Promise<void> {
  const { error } = await deps.db.from('sync_errors').insert({
    entity: 'notes',
    teamtailor_id: staging.teamtailor_id,
    error_code: 'OrphanFK',
    error_message: `notes[${staging.teamtailor_id}]: unresolved candidate tt_id=${staging.candidate_tt_id}`,
    payload: staging.raw_data as Record<string, unknown>,
    run_started_at: new Date().toISOString(),
  });
  if (error) {
    throw new SyncError('notes: failed to record orphan in sync_errors', {
      cause: error.message,
      teamtailorId: staging.teamtailor_id,
    });
  }
}

export const notesSyncer: EntitySyncer<NoteStaging> = {
  entity: 'notes',

  buildInitialRequest(cursor: string | null) {
    // Populate relationships.{candidate,job-application,user}.data
    // (TT returns link-only stubs by default).
    const params: Record<string, string> = {
      'page[size]': '30',
      include: 'candidate,job-application,user',
    };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/notes', params };
  },

  mapResource(resource: TTParsedResource): NoteStaging {
    const attrs = resource.attributes;
    const candidateTtId = relId(resource, 'candidate');
    if (!candidateTtId) {
      throw new ParseError(`notes[${resource.id}]: missing required relationship "candidate"`, {
        teamtailorId: resource.id,
      });
    }
    const rawBody = attrs['note'] ?? attrs['body'];
    const body = typeof rawBody === 'string' ? rawBody : '';
    if (body.length === 0) {
      throw new ParseError(`notes[${resource.id}]: body is empty (NOT NULL in schema)`, {
        teamtailorId: resource.id,
      });
    }
    return {
      teamtailor_id: resource.id,
      candidate_tt_id: candidateTtId,
      application_tt_id: relId(resource, 'job-application'),
      user_tt_id: relId(resource, 'user'),
      body,
      raw_data: resource,
    };
  },

  async upsert(stagings: NoteStaging[], deps: SyncerDeps): Promise<number> {
    if (stagings.length === 0) return 0;

    // Scope-by-candidates: drop out-of-scope rows silently (no orphan
    // entry in sync_errors). See SyncerDeps.scopeCandidateTtIds.
    const scope = deps.scopeCandidateTtIds;
    const scoped = scope ? stagings.filter((s) => scope.has(s.candidate_tt_id)) : stagings;
    if (scoped.length === 0) return 0;

    const candidateTtIds = Array.from(new Set(scoped.map((s) => s.candidate_tt_id)));
    const appTtIds = Array.from(
      new Set(scoped.map((s) => s.application_tt_id).filter((v): v is string => v !== null)),
    );
    const userTtIds = Array.from(
      new Set(scoped.map((s) => s.user_tt_id).filter((v): v is string => v !== null)),
    );

    const [candidateMap, appMap, userMap] = await Promise.all([
      buildIdMap(deps, 'candidates', candidateTtIds),
      buildIdMap(deps, 'applications', appTtIds),
      buildIdMap(deps, 'users', userTtIds),
    ]);

    const rows: Array<{
      teamtailor_id: string;
      candidate_id: string;
      application_id: string | null;
      user_id: string | null;
      body: string;
      raw_data: unknown;
    }> = [];

    for (const s of scoped) {
      const candidateId = candidateMap.get(s.candidate_tt_id);
      if (!candidateId) {
        await recordOrphan(deps, s);
        continue;
      }
      rows.push({
        teamtailor_id: s.teamtailor_id,
        candidate_id: candidateId,
        application_id: s.application_tt_id ? (appMap.get(s.application_tt_id) ?? null) : null,
        user_id: s.user_tt_id ? (userMap.get(s.user_tt_id) ?? null) : null,
        body: s.body,
        raw_data: s.raw_data,
      });
    }

    if (rows.length === 0) return 0;
    const { error } = await deps.db.from('notes').upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('notes upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
