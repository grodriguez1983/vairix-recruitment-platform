/**
 * Custom fields catalog syncer.
 *
 * Mirrors Teamtailor `custom-fields` into the local `custom_fields`
 * table. This is the catalog (field definitions), NOT the per-candidate
 * values — those are upserted by the candidates syncer via the
 * sideloaded `custom-field-values` resources (ADR-010 §2–§5).
 *
 * Sync order (ADR-010 §5): runs BEFORE candidates so that when a
 * candidate's value references a custom-field by Teamtailor id, the
 * FK in `candidate_custom_field_values.custom_field_id` can be
 * resolved.
 *
 * Attribute mapping note: `parseDocument` in the TT client shallow-
 * normalizes kebab-case keys to camelCase, so `api-name` arrives as
 * `apiName`, `field-type` as `fieldType`, etc.
 */
import { ParseError } from '../teamtailor/errors';
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';

export interface CustomFieldRow {
  teamtailor_id: string;
  api_name: string;
  name: string;
  field_type: string;
  owner_type: string;
  is_private: boolean;
  is_searchable: boolean;
  raw_data: unknown;
}

function requireString(attrs: Record<string, unknown>, key: string, ttId: string): string {
  const v = attrs[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new ParseError(`custom-fields[${ttId}]: missing required string attribute "${key}"`, {
      teamtailorId: ttId,
      key,
    });
  }
  return v;
}

function optionalBool(attrs: Record<string, unknown>, key: string): boolean {
  const v = attrs[key];
  return typeof v === 'boolean' ? v : false;
}

export const customFieldsSyncer: EntitySyncer<CustomFieldRow> = {
  entity: 'custom-fields',

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = { 'page[size]': '30' };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/custom-fields', params };
  },

  mapResource(resource: TTParsedResource): CustomFieldRow {
    const attrs = resource.attributes;
    return {
      teamtailor_id: resource.id,
      api_name: requireString(attrs, 'apiName', resource.id),
      name: requireString(attrs, 'name', resource.id),
      field_type: requireString(attrs, 'fieldType', resource.id),
      owner_type: requireString(attrs, 'ownerType', resource.id),
      is_private: optionalBool(attrs, 'isPrivate'),
      is_searchable: optionalBool(attrs, 'isSearchable'),
      raw_data: resource,
    };
  },

  async upsert(rows: CustomFieldRow[], deps: SyncerDeps): Promise<number> {
    if (rows.length === 0) return 0;
    const { error } = await deps.db
      .from('custom_fields')
      .upsert(rows, { onConflict: 'teamtailor_id' });
    if (error) {
      throw new SyncError('custom-fields upsert failed', {
        cause: error.message,
        count: rows.length,
      });
    }
    return rows.length;
  },
};
