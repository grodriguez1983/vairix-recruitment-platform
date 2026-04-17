/**
 * Stages syncer.
 *
 * Maps Teamtailor `stages` resources to rows in the local `stages`
 * table. The entity is deliberately the smallest one (per ADR-004
 * sync order) to validate the ETL skeleton end-to-end before
 * tackling candidates/applications.
 *
 * FK to `jobs`: stages carry a relationship to jobs in Teamtailor,
 * but jobs is synced LATER in the pipeline. Rather than create a
 * chicken-and-egg problem in F1-005, we set `job_id = null` here and
 * rely on the jobs syncer (F1-006) to reconcile FKs in a second
 * pass. This is safe because the column is nullable and there are no
 * queries depending on stages-to-jobs joins before the full pipeline
 * runs at least once.
 */
import { ParseError } from '../teamtailor/errors';
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';

export interface StageRow {
  teamtailor_id: string;
  job_id: string | null;
  name: string;
  slug: string | null;
  position: number | null;
  category: string | null;
  raw_data: unknown;
}

function requireString(attrs: Record<string, unknown>, key: string, ttId: string): string {
  const v = attrs[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ParseError(`stages[${ttId}]: missing required string attribute "${key}"`, {
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

function optionalInt(attrs: Record<string, unknown>, key: string): number | null {
  const v = attrs[key];
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null;
}

export const stagesSyncer: EntitySyncer<StageRow> = {
  entity: 'stages',

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = { 'page[size]': '30' };
    // Incremental cursor: filter by updated-at when we have a prior
    // watermark. First run (cursor=null) pulls everything.
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/stages', params };
  },

  mapResource(resource: TTParsedResource): StageRow {
    // attributes come camelCased from parseDocument (kebab→camel
    // shallow normalization), so `updated-at` → `updatedAt`.
    const attrs = resource.attributes;
    return {
      teamtailor_id: resource.id,
      job_id: null, // resolved later by F1-006 reconciliation pass
      name: requireString(attrs, 'name', resource.id),
      slug: optionalString(attrs, 'slug'),
      position: optionalInt(attrs, 'position'),
      category: optionalString(attrs, 'category'),
      raw_data: resource,
    };
  },

  async upsert(rows: StageRow[], deps: SyncerDeps): Promise<number> {
    if (rows.length === 0) return 0;
    const { error } = await deps.db.from('stages').upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('stages upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
