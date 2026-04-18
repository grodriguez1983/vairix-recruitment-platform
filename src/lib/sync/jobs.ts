/**
 * Jobs syncer.
 *
 * Maps Teamtailor `jobs` resources to rows in the local `jobs`
 * table. The DB `status` column has a CHECK constraint restricting
 * values to ('open', 'draft', 'archived', 'unlisted'); we coerce
 * unknown statuses to null rather than failing the row so Teamtailor
 * can introduce new states without breaking the sync.
 *
 * `department` and `location` arrive as relationships (not
 * attributes) and require `?include=department,location` to resolve.
 * Leaving them null in this first pass — the reconciliation will be
 * done in a later iteration once paginate exposes `included`.
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';
import { ParseError } from '../teamtailor/errors';

const ALLOWED_STATUSES = new Set(['open', 'draft', 'archived', 'unlisted']);

export interface JobRow {
  teamtailor_id: string;
  title: string;
  status: string | null;
  pitch: string | null;
  body: string | null;
  department: string | null;
  location: string | null;
  raw_data: unknown;
}

function requireString(attrs: Record<string, unknown>, key: string, ttId: string): string {
  const v = attrs[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ParseError(`jobs[${ttId}]: missing required string attribute "${key}"`, {
      teamtailorId: ttId,
      key,
    });
  }
  return v;
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

export const jobsSyncer: EntitySyncer<JobRow> = {
  entity: 'jobs',

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = { 'page[size]': '30' };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/jobs', params };
  },

  mapResource(resource: TTParsedResource): JobRow {
    const attrs = resource.attributes;
    return {
      teamtailor_id: resource.id,
      title: requireString(attrs, 'title', resource.id),
      status: normalizeStatus(attrs),
      pitch: optionalString(attrs, 'pitch'),
      body: optionalString(attrs, 'body'),
      department: null, // resolved from `included` in a later pass
      location: null, // resolved from `included` in a later pass
      raw_data: resource,
    };
  },

  async upsert(rows: JobRow[], deps: SyncerDeps): Promise<number> {
    if (rows.length === 0) return 0;
    const { error } = await deps.db.from('jobs').upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('jobs upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
