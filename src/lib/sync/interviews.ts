/**
 * Interviews syncer (Teamtailor `/v1/interviews` → `evaluations` +
 * `evaluation_answers`).
 *
 * FK reconciliation:
 *   - `candidate` → evaluations.candidate_id (REQUIRED; orphan →
 *     sync_errors, its answers are dropped to avoid orphan-cascade).
 *   - `job` + candidate → applications.id via (candidate_id, job_id)
 *     lookup (optional; unresolved → null).
 *   - `user` → evaluations.user_id (optional; unresolved → null).
 *
 * Sideloads (ADR-010 §2 pattern):
 *   `?include=answers,answers.question` so every page carries the
 *   answers owned by each interview plus the question definitions.
 *   The runner feeds `included` to `mapResource` via `includesSideloads`.
 *
 * Typed column mapping: each answer's `question-type` picks exactly
 * one of `value_text | value_range | value_boolean | value_number |
 * value_date`. raw_data keeps the JSON:API resource verbatim.
 */
import type { TTParsedResource } from '../teamtailor/types';
import type { EntitySyncer, SyncerDeps } from './run';
import { SyncError } from './errors';
import { ParseError } from '../teamtailor/errors';

interface AnswerStaging {
  teamtailor_answer_id: string;
  question_tt_id: string;
  question_title: string | null;
  question_type: string | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_range: number | null;
  raw_data: unknown;
}

export interface InterviewStaging {
  teamtailor_id: string;
  candidate_tt_id: string;
  job_tt_id: string | null;
  user_tt_id: string | null;
  notes: string | null;
  raw_data: unknown;
  answers: AnswerStaging[];
}

function relId(resource: TTParsedResource, relation: string): string | null {
  const rel = resource.relationships?.[relation];
  if (!rel || !rel.data || Array.isArray(rel.data)) return null;
  return rel.data.id;
}

function relIds(resource: TTParsedResource, relation: string): string[] {
  const rel = resource.relationships?.[relation];
  if (!rel || !rel.data) return [];
  return Array.isArray(rel.data) ? rel.data.map((d) => d.id) : [rel.data.id];
}

function optionalString(attrs: Record<string, unknown>, key: string): string | null {
  const v = attrs[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Picks typed column for a TT answer based on its question-type. */
function castAnswerValue(
  questionType: string | null,
  attrs: Record<string, unknown>,
): Pick<
  AnswerStaging,
  'value_text' | 'value_number' | 'value_boolean' | 'value_date' | 'value_range'
> {
  const base = {
    value_text: null as string | null,
    value_number: null as number | null,
    value_boolean: null as boolean | null,
    value_date: null as string | null,
    value_range: null as number | null,
  };
  const t = (questionType ?? '').toLowerCase();
  switch (t) {
    case 'text': {
      const text =
        typeof attrs['text'] === 'string'
          ? (attrs['text'] as string)
          : typeof attrs['answer'] === 'string'
            ? (attrs['answer'] as string)
            : null;
      return { ...base, value_text: text };
    }
    case 'range': {
      const r = attrs['range'];
      return { ...base, value_range: typeof r === 'number' ? r : null };
    }
    case 'boolean': {
      const b = attrs['boolean'];
      return { ...base, value_boolean: typeof b === 'boolean' ? b : null };
    }
    case 'number': {
      const n = attrs['number'];
      return { ...base, value_number: typeof n === 'number' ? n : null };
    }
    case 'date': {
      const d = attrs['date'];
      if (typeof d !== 'string') return base;
      const parsed = new Date(d);
      if (Number.isNaN(parsed.getTime())) return base;
      return { ...base, value_date: parsed.toISOString().slice(0, 10) };
    }
    default:
      return base;
  }
}

async function buildIdMap(
  deps: SyncerDeps,
  table: 'candidates' | 'jobs' | 'users',
  ttIds: string[],
): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (ttIds.length === 0) return map;
  const { data, error } = await deps.db
    .from(table)
    .select('id, teamtailor_id')
    .in('teamtailor_id', ttIds);
  if (error) {
    throw new SyncError(`interviews: failed to resolve ${table} FKs`, {
      cause: error.message,
      count: ttIds.length,
    });
  }
  for (const row of data ?? []) map.set(row.teamtailor_id as string, row.id as string);
  return map;
}

async function recordOrphan(deps: SyncerDeps, staging: InterviewStaging): Promise<void> {
  const { error } = await deps.db.from('sync_errors').insert({
    entity: 'evaluations',
    teamtailor_id: staging.teamtailor_id,
    error_code: 'OrphanFK',
    error_message: `interviews[${staging.teamtailor_id}]: unresolved candidate tt_id=${staging.candidate_tt_id}`,
    payload: staging.raw_data as Record<string, unknown>,
    run_started_at: new Date().toISOString(),
  });
  if (error) {
    throw new SyncError('interviews: failed to record orphan in sync_errors', {
      cause: error.message,
      teamtailorId: staging.teamtailor_id,
    });
  }
}

export const interviewsSyncer: EntitySyncer<InterviewStaging> = {
  entity: 'evaluations',
  includesSideloads: true,

  buildInitialRequest(cursor: string | null) {
    const params: Record<string, string> = {
      'page[size]': '30',
      include: 'answers,answers.question',
    };
    if (cursor) params['filter[updated-at][from]'] = cursor;
    return { path: '/interviews', params };
  },

  mapResource(resource: TTParsedResource, included: TTParsedResource[]): InterviewStaging {
    const attrs = resource.attributes;
    const candidateTtId = relId(resource, 'candidate');
    if (!candidateTtId) {
      throw new ParseError(
        `interviews[${resource.id}]: missing required relationship "candidate"`,
        { teamtailorId: resource.id },
      );
    }

    // Build a quick index over sideloaded questions so we can resolve
    // each answer's question_title.
    const questionById = new Map<string, TTParsedResource>();
    for (const inc of included) {
      if (inc.type === 'questions') questionById.set(inc.id, inc);
    }

    const ownedAnswerIds = new Set(relIds(resource, 'answers'));
    const answers: AnswerStaging[] = [];
    for (const inc of included) {
      if (inc.type !== 'answers') continue;
      if (!ownedAnswerIds.has(inc.id)) continue;
      const ansAttrs = inc.attributes;
      const questionTtId = relId(inc, 'question');
      if (!questionTtId) continue;
      const questionType =
        typeof ansAttrs['questionType'] === 'string' ? (ansAttrs['questionType'] as string) : null;
      const question = questionById.get(questionTtId);
      const questionTitle = question ? optionalString(question.attributes, 'title') : null;
      const cast = castAnswerValue(questionType, ansAttrs);
      answers.push({
        teamtailor_answer_id: inc.id,
        question_tt_id: questionTtId,
        question_title: questionTitle,
        question_type: questionType ? questionType.toLowerCase() : null,
        ...cast,
        raw_data: inc,
      });
    }

    return {
      teamtailor_id: resource.id,
      candidate_tt_id: candidateTtId,
      job_tt_id: relId(resource, 'job'),
      user_tt_id: relId(resource, 'user'),
      notes: optionalString(attrs, 'note'),
      raw_data: resource,
      answers,
    };
  },

  async upsert(stagings: InterviewStaging[], deps: SyncerDeps): Promise<number> {
    if (stagings.length === 0) return 0;

    const candidateTtIds = Array.from(new Set(stagings.map((s) => s.candidate_tt_id)));
    const jobTtIds = Array.from(
      new Set(stagings.map((s) => s.job_tt_id).filter((v): v is string => v !== null)),
    );
    const userTtIds = Array.from(
      new Set(stagings.map((s) => s.user_tt_id).filter((v): v is string => v !== null)),
    );

    const [candidateMap, jobMap, userMap] = await Promise.all([
      buildIdMap(deps, 'candidates', candidateTtIds),
      buildIdMap(deps, 'jobs', jobTtIds),
      buildIdMap(deps, 'users', userTtIds),
    ]);

    // Resolve application_id via (candidate_id, job_id). We query for
    // every candidate×job pair that actually appears in this batch.
    const candidateIds = Array.from(candidateMap.values());
    const jobIds = Array.from(jobMap.values());
    const appByCandidateJob = new Map<string, string>();
    if (candidateIds.length > 0 && jobIds.length > 0) {
      const { data: apps, error: appErr } = await deps.db
        .from('applications')
        .select('id, candidate_id, job_id')
        .in('candidate_id', candidateIds)
        .in('job_id', jobIds);
      if (appErr) {
        throw new SyncError('interviews: failed to resolve applications', {
          cause: appErr.message,
        });
      }
      for (const a of apps ?? []) {
        appByCandidateJob.set(`${a.candidate_id}::${a.job_id}`, a.id as string);
      }
    }

    type EvalRow = {
      teamtailor_id: string;
      candidate_id: string;
      application_id: string | null;
      user_id: string | null;
      notes: string | null;
      raw_data: unknown;
    };
    const evalRows: EvalRow[] = [];
    // Track answers per interview so we can attach them once the
    // evaluation UUID is known.
    const answersByInterviewTtId = new Map<string, AnswerStaging[]>();

    for (const s of stagings) {
      const candidateId = candidateMap.get(s.candidate_tt_id);
      if (!candidateId) {
        await recordOrphan(deps, s);
        // Answers of orphan interviews never land in evaluation_answers.
        continue;
      }
      const jobId = s.job_tt_id ? (jobMap.get(s.job_tt_id) ?? null) : null;
      const applicationId = jobId
        ? (appByCandidateJob.get(`${candidateId}::${jobId}`) ?? null)
        : null;
      const userId = s.user_tt_id ? (userMap.get(s.user_tt_id) ?? null) : null;
      evalRows.push({
        teamtailor_id: s.teamtailor_id,
        candidate_id: candidateId,
        application_id: applicationId,
        user_id: userId,
        notes: s.notes,
        raw_data: s.raw_data,
      });
      if (s.answers.length > 0) {
        answersByInterviewTtId.set(s.teamtailor_id, s.answers);
      }
    }

    if (evalRows.length === 0) return 0;

    const { data: upsertedEvals, error: evalErr } = await deps.db
      .from('evaluations')
      .upsert(evalRows, { onConflict: 'teamtailor_id' })
      .select('id, teamtailor_id');
    if (evalErr) {
      throw new SyncError('evaluations upsert failed', {
        cause: evalErr.message,
        count: evalRows.length,
      });
    }
    const evalIdByTtId = new Map<string, string>(
      (upsertedEvals ?? []).map((e) => [e.teamtailor_id as string, e.id as string]),
    );

    // Build evaluation_answers rows with resolved evaluation_id.
    const ansRows = Array.from(answersByInterviewTtId.entries()).flatMap(
      ([interviewTtId, answers]) => {
        const evalId = evalIdByTtId.get(interviewTtId);
        if (!evalId) return [];
        return answers.map((a) => ({
          evaluation_id: evalId,
          teamtailor_answer_id: a.teamtailor_answer_id,
          question_tt_id: a.question_tt_id,
          question_title: a.question_title,
          question_type: a.question_type,
          value_text: a.value_text,
          value_number: a.value_number,
          value_boolean: a.value_boolean,
          value_date: a.value_date,
          value_range: a.value_range,
          raw_data: a.raw_data,
        }));
      },
    );

    if (ansRows.length > 0) {
      const { error: ansErr } = await deps.db
        .from('evaluation_answers')
        .upsert(ansRows, { onConflict: 'teamtailor_answer_id' });
      if (ansErr) {
        throw new SyncError('evaluation_answers upsert failed', {
          cause: ansErr.message,
          count: ansRows.length,
        });
      }
    }

    return evalRows.length;
  },
};
