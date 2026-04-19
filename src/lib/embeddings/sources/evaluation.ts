/**
 * Evaluation source builder for the embeddings pipeline (ADR-005
 * §Fuentes a embeber).
 *
 * Aggregates a candidate's `evaluations` (interview scorecards) into
 * a single embedding input — one `evaluation` embedding per candidate
 * (source_id null), mirroring the profile/notes/cv shape so that the
 * RAG layer can dedupe per (candidate_id, source_type).
 *
 * Per-evaluation block:
 *   - Header line: decision · score · evaluator name (when present).
 *   - The `notes` free-text body.
 *   - One `Q: ... → A: ...` line per `evaluation_answers` row, taking
 *     the first non-null typed value column (text/number/range/
 *     boolean/date) so the embedding sees structured-question
 *     content even when the recruiter left the free-text empty.
 *
 * Determinism: evaluations are sorted by `createdAt` (oldest first)
 * and answers within each evaluation by `questionTtId` so identical
 * inputs always produce identical strings — required for the
 * `content_hash` cache to invalidate correctly.
 *
 * Empty evaluations (no notes, no answers with values) are dropped;
 * if nothing remains for the candidate we return null so the worker
 * skips them.
 */
export interface EvaluationAnswerInput {
  questionTtId: string;
  questionTitle: string | null;
  valueText: string | null;
  valueNumber: number | null;
  valueBoolean: boolean | null;
  valueDate: string | null;
  valueRange: number | null;
}

export interface EvaluationInput {
  evaluationId: string;
  decision: string | null;
  score: number | null;
  evaluatorName: string | null;
  notes: string | null;
  createdAt: string | Date | null;
  answers: readonly EvaluationAnswerInput[];
}

export interface EvaluationSourceInput {
  candidateId: string;
  evaluations: readonly EvaluationInput[];
}

function toTimestamp(v: string | Date | null): number {
  if (v === null) return 0;
  if (v instanceof Date) return v.getTime();
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function clean(s: string | null): string {
  if (s === null) return '';
  return s.replace(/\s+/g, ' ').trim();
}

function answerValue(a: EvaluationAnswerInput): string {
  const text = clean(a.valueText);
  if (text.length > 0) return text;
  if (a.valueNumber !== null) return a.valueNumber.toString();
  if (a.valueRange !== null) return a.valueRange.toString();
  if (a.valueBoolean !== null) return a.valueBoolean ? 'Yes' : 'No';
  if (a.valueDate) return a.valueDate;
  return '';
}

function buildEvaluationBlock(e: EvaluationInput): string | null {
  const headerParts: string[] = [];
  if (e.decision) headerParts.push(`decision: ${clean(e.decision)}`);
  if (e.score !== null) headerParts.push(`score: ${e.score}`);
  const evaluator = clean(e.evaluatorName);
  if (evaluator.length > 0) headerParts.push(`by ${evaluator}`);
  const header = headerParts.length > 0 ? headerParts.join(' · ') : null;

  const body = clean(e.notes);

  const sortedAnswers = [...e.answers].sort((a, b) => a.questionTtId.localeCompare(b.questionTtId));
  const answerLines: string[] = [];
  for (const a of sortedAnswers) {
    const value = answerValue(a);
    if (value.length === 0) continue;
    const title = clean(a.questionTitle) || a.questionTtId;
    answerLines.push(`Q: ${title} → A: ${value}`);
  }

  const parts: string[] = [];
  if (header) parts.push(header);
  if (body.length > 0) parts.push(body);
  if (answerLines.length > 0) parts.push(answerLines.join('\n'));

  if (parts.length === 0) return null;
  return parts.join('\n');
}

export function buildEvaluationContent(input: EvaluationSourceInput): string | null {
  const sorted = [...input.evaluations].sort(
    (a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt),
  );
  const blocks: string[] = [];
  for (const e of sorted) {
    const block = buildEvaluationBlock(e);
    if (block === null) continue;
    blocks.push(block);
  }
  if (blocks.length === 0) return null;
  return blocks.join('\n\n');
}
