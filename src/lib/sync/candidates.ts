/**
 * Candidates syncer.
 *
 * Mirror Teamtailor candidates into the local `candidates` table. No
 * field is required by the DB schema beyond `teamtailor_id`, and TT
 * itself tolerates mostly-null candidates (e.g., after a GDPR-style
 * wipe), so this mapper never throws on missing PII — it simply
 * stores null and keeps the row.
 *
 * Attribute keys arrive camelCased from parseDocument
 * (`first-name` → `firstName`, `linkedin-url` → `linkedinUrl`).
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';

export interface CandidateRow {
  teamtailor_id: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  linkedin_url: string | null;
  pitch: string | null;
  sourced: boolean;
  raw_data: unknown;
}

function optionalString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function boolOrFalse(attrs: Record<string, unknown>, key: string): boolean {
  return attrs[key] === true;
}

export const candidatesSyncer: EntitySyncer<CandidateRow> = {
  entity: 'candidates',

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = { 'page[size]': '30' };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/candidates', params };
  },

  mapResource(resource: TTParsedResource): CandidateRow {
    const attrs = resource.attributes;
    return {
      teamtailor_id: resource.id,
      first_name: optionalString(attrs, 'firstName'),
      last_name: optionalString(attrs, 'lastName'),
      email: optionalString(attrs, 'email'),
      phone: optionalString(attrs, 'phone'),
      linkedin_url: optionalString(attrs, 'linkedinUrl'),
      pitch: optionalString(attrs, 'pitch'),
      sourced: boolOrFalse(attrs, 'sourced'),
      raw_data: resource,
    };
  },

  async upsert(rows: CandidateRow[], deps: SyncerDeps): Promise<number> {
    if (rows.length === 0) return 0;
    const { error } = await deps.db
      .from('candidates')
      .upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('candidates upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
