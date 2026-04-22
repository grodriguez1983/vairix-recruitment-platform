/**
 * Helpers for candidate sideloaded custom-field-values (ADR-010).
 *
 * Extracted from `candidates.ts` to keep that module under 300 LOC
 * after the ADR-018 resume-download hook was added.
 *
 * `castValue` — turns a TT raw value (always delivered as a
 * stringish attribute) into the typed column matching the field's
 * declared `field_type`. `raw_value` is always preserved; typed
 * columns are populated only when the cast succeeds. This keeps
 * auditability when TT data drifts.
 *
 * `upsertCustomFieldValues` — batches a candidate-upsert-scoped
 * resolution + upsert into `candidate_custom_field_values`. Looks
 * up `custom_fields.field_type` for every referenced catalog id,
 * then casts + upserts.
 */
import type { SyncerDeps } from './run';
import { SyncError } from './errors';

import type { CandidateCustomFieldValueInput } from './candidates';

export function castValue(
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

export async function upsertCustomFieldValues(
  valueInputs: CandidateCustomFieldValueInput[],
  candidateIdByTtId: Map<string, string>,
  deps: SyncerDeps,
): Promise<void> {
  if (valueInputs.length === 0) return;
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
  if (valueRows.length === 0) return;
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
