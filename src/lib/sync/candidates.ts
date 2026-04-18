/**
 * Candidates syncer.
 *
 * Mirrors Teamtailor candidates into `candidates` AND their sideloaded
 * custom-field-values into `candidate_custom_field_values` (ADR-010
 * §2, §5, §6).
 *
 * Pulls `/candidates?include=custom-field-values,custom-field-values.custom-field`
 * so every page carries the values the candidate owns in
 * `document.included`. The runner feeds `included` to `mapResource`
 * via the `includesSideloads` flag (see EntitySyncer).
 *
 * Value casting is defensive: `raw_value` is always stored, the
 * typed column (`value_text` | `value_date` | ...) is populated only
 * if the cast succeeds for the field's declared `field_type`. This
 * keeps auditability even when TT data drifts.
 *
 * Attribute keys arrive camelCased from parseDocument
 * (`first-name` → `firstName`, `linkedin-url` → `linkedinUrl`).
 * Relationships are preserved verbatim (still kebab-case keys).
 */
import type { TTParsedResource, TTJsonApiRelationshipData } from '../teamtailor/types';
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

/**
 * Intermediate shape emitted per candidate value. FK ids are
 * resolved inside `upsert()` because the candidate UUID doesn't exist
 * until the candidates upsert completes and the custom_field UUID
 * requires a lookup against the catalog.
 */
export interface CandidateCustomFieldValueInput {
  teamtailor_value_id: string;
  candidate_teamtailor_id: string;
  custom_field_teamtailor_id: string;
  field_type: string;
  value_text: string | null;
  value_date: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  raw_value: string | null;
}

export interface CandidateWithValues {
  candidate: CandidateRow;
  customFieldValues: CandidateCustomFieldValueInput[];
}

function optionalString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function boolOrFalse(attrs: Record<string, unknown>, key: string): boolean {
  return attrs[key] === true;
}

function getRelationshipIds(resource: TTParsedResource, relName: string): string[] {
  const rel = resource.relationships?.[relName];
  if (!rel) return [];
  const data = rel.data;
  if (!data) return [];
  const arr: TTJsonApiRelationshipData[] = Array.isArray(data) ? data : [data];
  return arr.filter((x) => x.type === 'custom-field-values').map((x) => x.id);
}

function getSingleRelationshipId(
  resource: TTParsedResource,
  relName: string,
  expectedType: string,
): string | null {
  const rel = resource.relationships?.[relName];
  if (!rel || !rel.data) return null;
  const data = rel.data;
  if (Array.isArray(data)) return null;
  if (data.type !== expectedType) return null;
  return data.id;
}

/**
 * Casts a raw TT value string into the typed column for the given
 * field_type. Returns an input row with `raw_value` always set and
 * the other `value_*` fields null except the one matching the type
 * (when casting succeeds).
 */
function castValue(
  fieldType: string,
  rawValue: unknown,
): Omit<
  CandidateCustomFieldValueInput,
  'teamtailor_value_id' | 'candidate_teamtailor_id' | 'custom_field_teamtailor_id' | 'field_type'
> {
  const raw = typeof rawValue === 'string' ? rawValue : rawValue == null ? null : String(rawValue);
  const base = {
    value_text: null as string | null,
    value_date: null as string | null,
    value_number: null as number | null,
    value_boolean: null as boolean | null,
    raw_value: raw,
  };
  if (raw === null) return base;
  switch (fieldType) {
    case 'CustomField::Text':
      return { ...base, value_text: raw };
    case 'CustomField::Date': {
      // Accept ISO 8601 full or date-only; normalize to YYYY-MM-DD.
      const d = new Date(raw);
      if (Number.isNaN(d.getTime())) return base;
      return { ...base, value_date: d.toISOString().slice(0, 10) };
    }
    case 'CustomField::Number': {
      const n = Number(raw);
      if (!Number.isFinite(n)) return base;
      return { ...base, value_number: n };
    }
    case 'CustomField::Boolean': {
      if (raw === 'true') return { ...base, value_boolean: true };
      if (raw === 'false') return { ...base, value_boolean: false };
      return base;
    }
    default:
      // Unknown field_type: leave typed columns null, keep raw_value.
      return base;
  }
}

export const candidatesSyncer: EntitySyncer<CandidateWithValues> = {
  entity: 'candidates',
  includesSideloads: true,

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = {
      'page[size]': '30',
      // ADR-010 §2: pull each candidate's custom-field-values and the
      // nested custom-field definitions so the mapper has enough to
      // produce candidate_custom_field_values rows.
      include: 'custom-field-values,custom-field-values.custom-field',
    };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/candidates', params };
  },

  mapResource(resource: TTParsedResource, included: TTParsedResource[]): CandidateWithValues {
    const attrs = resource.attributes;
    const candidate: CandidateRow = {
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

    const ownedValueIds = new Set(getRelationshipIds(resource, 'custom-field-values'));
    const values: CandidateCustomFieldValueInput[] = [];
    for (const inc of included) {
      if (inc.type !== 'custom-field-values') continue;
      if (!ownedValueIds.has(inc.id)) continue;
      const customFieldId = getSingleRelationshipId(inc, 'custom-field', 'custom-fields');
      if (!customFieldId) continue;
      // `custom-field-values` resources in TT expose the value under
      // attributes.value (string-ish). The typed column cast happens
      // in upsert() once we have the catalog field_type resolved;
      // here we only capture raw_value and the FK teamtailor ids.
      const rawValue = (inc.attributes as Record<string, unknown>).value;
      values.push({
        teamtailor_value_id: inc.id,
        candidate_teamtailor_id: resource.id,
        custom_field_teamtailor_id: customFieldId,
        // Sentinel — overwritten in upsert() from the catalog lookup.
        field_type: '',
        value_text: null,
        value_date: null,
        value_number: null,
        value_boolean: null,
        raw_value:
          typeof rawValue === 'string' ? rawValue : rawValue == null ? null : String(rawValue),
      });
    }

    return { candidate, customFieldValues: values };
  },

  async upsert(rows: CandidateWithValues[], deps: SyncerDeps): Promise<number> {
    if (rows.length === 0) return 0;

    // 1) Upsert candidates and recover their local UUIDs.
    const candidateRows = rows.map((r) => r.candidate);
    const { data: upsertedCandidates, error: candErr } = await deps.db
      .from('candidates')
      .upsert(candidateRows, { onConflict: 'teamtailor_id' })
      .select('id, teamtailor_id');
    if (candErr) {
      throw new SyncError('candidates upsert failed', {
        cause: candErr.message,
        count: candidateRows.length,
      });
    }
    const candidateIdByTtId = new Map<string, string>(
      (upsertedCandidates ?? []).map((c) => [c.teamtailor_id, c.id]),
    );

    // 2) Collect all value inputs and look up their custom_field UUIDs.
    const valueInputs = rows.flatMap((r) => r.customFieldValues);
    if (valueInputs.length === 0) return rows.length;

    const neededCatalogIds = Array.from(
      new Set(valueInputs.map((v) => v.custom_field_teamtailor_id)),
    );
    const { data: catalog, error: catErr } = await deps.db
      .from('custom_fields')
      .select('id, teamtailor_id, field_type')
      .in('teamtailor_id', neededCatalogIds);
    if (catErr) {
      throw new SyncError('custom_fields lookup failed', { cause: catErr.message });
    }
    const catalogByTtId = new Map<string, { id: string; field_type: string }>(
      (catalog ?? []).map((c) => [c.teamtailor_id, { id: c.id, field_type: c.field_type }]),
    );

    // 3) Build the final value rows with resolved FKs and cast types.
    const valueRows = valueInputs.flatMap((v) => {
      const candUuid = candidateIdByTtId.get(v.candidate_teamtailor_id);
      const catalogEntry = catalogByTtId.get(v.custom_field_teamtailor_id);
      if (!candUuid || !catalogEntry) return [];
      const cast = castValue(catalogEntry.field_type, v.raw_value);
      return [
        {
          candidate_id: candUuid,
          custom_field_id: catalogEntry.id,
          teamtailor_value_id: v.teamtailor_value_id,
          field_type: catalogEntry.field_type,
          value_text: cast.value_text,
          value_date: cast.value_date,
          value_number: cast.value_number,
          value_boolean: cast.value_boolean,
          raw_value: cast.raw_value,
        },
      ];
    });

    if (valueRows.length > 0) {
      const { error: valErr } = await deps.db
        .from('candidate_custom_field_values')
        .upsert(valueRows, { onConflict: 'teamtailor_value_id' });
      if (valErr) {
        throw new SyncError('candidate_custom_field_values upsert failed', {
          cause: valErr.message,
          count: valueRows.length,
        });
      }
    }

    return rows.length;
  },
};
