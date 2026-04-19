/**
 * Evaluation-source embeddings worker (ADR-005, F3-001).
 *
 * Aggregates a candidate's interview scorecards (`evaluations` +
 * `evaluation_answers`) into a single embedding input. One row per
 * candidate (`source_type='evaluation'`, `source_id=null`).
 * Idempotent via `content_hash`; regenerates when an evaluation or
 * any of its answers change, and when the provider model changes.
 *
 * Delegates the loop, pagination, hash comparison, and upsert to
 * `runEmbeddingsWorker`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from './provider';
import {
  buildEvaluationContent,
  type EvaluationInput,
  type EvaluationAnswerInput,
} from './sources/evaluation';
import {
  runEmbeddingsWorker,
  type EmbeddingsRunResult,
  type EmbeddingsSourceHandler,
  type RunEmbeddingsOptions,
} from './worker-runtime';

export type RunEvaluationEmbeddingsOptions = RunEmbeddingsOptions;
export type EvaluationEmbeddingsResult = EmbeddingsRunResult;

interface EvaluationRow {
  id: string;
  candidate_id: string;
  decision: string | null;
  score: number | null;
  evaluator_name: string | null;
  notes: string | null;
  created_at: string | null;
}

interface EvaluationAnswerRow {
  evaluation_id: string;
  question_tt_id: string;
  question_title: string | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_range: number | null;
}

async function loadEvaluationsByCandidate(
  db: SupabaseClient,
  candidateIds: readonly string[],
): Promise<Map<string, EvaluationInput[]>> {
  const byCandidate = new Map<string, EvaluationInput[]>();
  if (candidateIds.length === 0) return byCandidate;

  const { data: evalRows, error: evalErr } = await db
    .from('evaluations')
    .select('id, candidate_id, decision, score, evaluator_name, notes, created_at')
    .is('deleted_at', null)
    .in('candidate_id', [...candidateIds]);
  if (evalErr) throw new Error(`failed to load evaluations: ${evalErr.message}`);

  const evals = (evalRows ?? []) as EvaluationRow[];
  if (evals.length === 0) return byCandidate;

  const evalIds = evals.map((e) => e.id);
  const { data: answerRows, error: ansErr } = await db
    .from('evaluation_answers')
    .select(
      'evaluation_id, question_tt_id, question_title, value_text, value_number, value_boolean, value_date, value_range',
    )
    .in('evaluation_id', evalIds);
  if (ansErr) throw new Error(`failed to load evaluation_answers: ${ansErr.message}`);

  const answersByEval = new Map<string, EvaluationAnswerInput[]>();
  for (const row of (answerRows ?? []) as EvaluationAnswerRow[]) {
    const arr = answersByEval.get(row.evaluation_id) ?? [];
    arr.push({
      questionTtId: row.question_tt_id,
      questionTitle: row.question_title,
      valueText: row.value_text,
      valueNumber: row.value_number,
      valueBoolean: row.value_boolean,
      valueDate: row.value_date,
      valueRange: row.value_range,
    });
    answersByEval.set(row.evaluation_id, arr);
  }

  for (const e of evals) {
    const arr = byCandidate.get(e.candidate_id) ?? [];
    arr.push({
      evaluationId: e.id,
      decision: e.decision,
      score: e.score,
      evaluatorName: e.evaluator_name,
      notes: e.notes,
      createdAt: e.created_at,
      answers: answersByEval.get(e.id) ?? [],
    });
    byCandidate.set(e.candidate_id, arr);
  }

  return byCandidate;
}

export const evaluationSourceHandler: EmbeddingsSourceHandler = {
  sourceType: 'evaluation',
  async buildContents(db, candidateIds) {
    const byCandidate = await loadEvaluationsByCandidate(db, candidateIds);
    const out = new Map<string, string | null>();
    for (const id of candidateIds) {
      out.set(
        id,
        buildEvaluationContent({
          candidateId: id,
          evaluations: byCandidate.get(id) ?? [],
        }),
      );
    }
    return out;
  },
};

export async function runEvaluationEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunEvaluationEmbeddingsOptions = {},
): Promise<EvaluationEmbeddingsResult> {
  return runEmbeddingsWorker(db, provider, evaluationSourceHandler, options);
}
