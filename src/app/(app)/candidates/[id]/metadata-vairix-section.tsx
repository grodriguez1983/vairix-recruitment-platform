/**
 * "Metadata VAIRIX" section of the candidate profile.
 *
 * Renders every `candidate_custom_field_values` row joined to its
 * `custom_fields` definition, sorted by field name. Only rows whose
 * join to `custom_fields` resolved are shown (a null join means the
 * definition was dropped or RLS hid it; either way it's not
 * renderable).
 *
 * The display picker mirrors the typed-column convention in the
 * values table (one typed column per CustomField::* subtype, with
 * `raw_value` as the always-present fallback).
 */
import type { createClient } from '@/lib/supabase/server';

export interface CustomFieldValueRow {
  id: string;
  field_type: string;
  value_text: string | null;
  value_date: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  raw_value: string | null;
  custom_fields: {
    name: string;
    api_name: string;
    is_private: boolean;
  } | null;
}

export async function fetchCustomFieldValues(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<CustomFieldValueRow[]> {
  const { data } = await supabase
    .from('candidate_custom_field_values')
    .select(
      'id, field_type, value_text, value_date, value_number, value_boolean, raw_value, custom_fields(name, api_name, is_private)',
    )
    .eq('candidate_id', candidateId);
  return ((data ?? []) as unknown as CustomFieldValueRow[])
    .filter((v) => v.custom_fields !== null)
    .sort((a, b) => (a.custom_fields?.name ?? '').localeCompare(b.custom_fields?.name ?? ''));
}

function displayValue(v: CustomFieldValueRow): string {
  switch (v.field_type) {
    case 'CustomField::Text':
      return v.value_text ?? v.raw_value ?? '';
    case 'CustomField::Date':
      return v.value_date ?? v.raw_value ?? '';
    case 'CustomField::Number':
      return v.value_number?.toString() ?? v.raw_value ?? '';
    case 'CustomField::Boolean':
      if (v.value_boolean === true) return 'Yes';
      if (v.value_boolean === false) return 'No';
      return v.raw_value ?? '';
    default:
      return v.raw_value ?? '';
  }
}

export function MetadataVairixSection({
  values,
}: {
  values: CustomFieldValueRow[];
}): JSX.Element | null {
  if (values.length === 0) return null;
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
        Metadata VAIRIX{' '}
        <span className="font-mono text-xs font-normal text-text-muted">({values.length})</span>
      </h2>
      <dl className="grid gap-x-6 gap-y-3 rounded-lg border border-border bg-surface p-5 sm:grid-cols-2">
        {values.map((v) => (
          <div key={v.id} className="flex min-w-0 flex-col gap-0.5">
            <dt className="flex items-center gap-2 text-xs text-text-muted">
              {v.custom_fields?.name ?? v.custom_fields?.api_name ?? '—'}
              {v.custom_fields?.is_private && (
                <span
                  title="Private field"
                  className="rounded-sm bg-warning/10 px-1.5 py-0 font-mono text-[9px] uppercase tracking-widest text-warning"
                >
                  private
                </span>
              )}
            </dt>
            <dd className="break-words font-mono text-sm text-text-primary">
              {displayValue(v) || <span className="italic text-text-muted">—</span>}
            </dd>
          </div>
        ))}
      </dl>
    </section>
  );
}
