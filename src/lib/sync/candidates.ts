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
import type { EntitySyncer } from './run';
import type { CandidateResumeInput, CandidateResumeResult } from './candidate-resumes';
import { upsertCustomFieldValues } from './candidate-custom-fields';
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
  /**
   * Short-lived signed URL from `candidates.attributes.resume`
   * (ADR-018). Non-null when the candidate has a TT-generated PDF;
   * expires ~60s after the JSON:API response renders, so the resume
   * downloader MUST be invoked inside the same sync pass.
   */
  resume_url: string | null;
}

export interface CandidatesSyncerFactoryDeps {
  /**
   * Optional post-upsert hook (ADR-018). When wired, the syncer
   * invokes it after candidates are persisted, passing every
   * row's (candidate_tt_id, resume_url) pair plus the local-id map.
   * Failures are swallowed so a bad resume URL can't abort the
   * candidates batch.
   */
  downloadResumesForRows?: (
    inputs: CandidateResumeInput[],
    candidateIdByTtId: Map<string, string>,
  ) => Promise<CandidateResumeResult>;
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

function mapResource(
  resource: TTParsedResource,
  included: TTParsedResource[],
): CandidateWithValues {
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

  return { candidate, customFieldValues: values, resume_url: optionalString(attrs, 'resume') };
}

export function makeCandidatesSyncer(
  factoryDeps: CandidatesSyncerFactoryDeps = {},
): EntitySyncer<CandidateWithValues> {
  return {
    entity: 'candidates',
    includesSideloads: true,

    buildInitialRequest(cursor: string | null) {
      const params: Record<string, string> = {
        'page[size]': '30',
        // ADR-010 §2: pull each candidate's custom-field-values and
        // the nested custom-field definitions so the mapper has
        // enough to produce candidate_custom_field_values rows.
        include: 'custom-field-values,custom-field-values.custom-field',
      };
      if (cursor) params['filter[updated-at][from]'] = cursor;
      return { path: '/candidates', params };
    },

    mapResource,

    async upsert(rows, deps) {
      if (rows.length === 0) return 0;

      // 1) Upsert candidates and recover their local UUIDs.
      const { data: upsertedCandidates, error: candErr } = await deps.db
        .from('candidates')
        .upsert(
          rows.map((r) => r.candidate),
          { onConflict: 'teamtailor_id' },
        )
        .select('id, teamtailor_id');
      if (candErr) {
        throw new SyncError('candidates upsert failed', {
          cause: candErr.message,
          count: rows.length,
        });
      }
      const candidateIdByTtId = new Map<string, string>(
        (upsertedCandidates ?? []).map((c) => [c.teamtailor_id, c.id]),
      );

      // 2) Upsert sideloaded custom-field-values.
      await upsertCustomFieldValues(
        rows.flatMap((r) => r.customFieldValues),
        candidateIdByTtId,
        deps,
      );

      // 3) Post-upsert hook: download candidates.attributes.resume
      // binaries (ADR-018). Orthogonal to the candidates batch —
      // errors are swallowed so a flaky S3 signed URL never aborts
      // the sync. When the hook is unset (legacy static export) we
      // simply skip this step.
      if (factoryDeps.downloadResumesForRows) {
        try {
          await factoryDeps.downloadResumesForRows(
            rows.map((r) => ({
              candidate_tt_id: r.candidate.teamtailor_id,
              resume_url: r.resume_url,
            })),
            candidateIdByTtId,
          );
        } catch {
          // Swallow — resume download is best-effort.
        }
      }

      return rows.length;
    },
  };
}

/**
 * Legacy static export. Does NOT download candidate resumes —
 * callers that want ADR-018 behavior must use
 * `makeCandidatesSyncer({ downloadResumesForRows })` instead.
 */
export const candidatesSyncer: EntitySyncer<CandidateWithValues> = makeCandidatesSyncer();
