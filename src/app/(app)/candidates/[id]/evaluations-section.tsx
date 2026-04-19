/**
 * "Evaluations" section of the candidate profile.
 *
 * Surfaces every evaluation (interview scorecard) synced from
 * Teamtailor for the candidate, most-recent first. Each card shows
 * decision + score + evaluator + free-text `notes`, plus the
 * structured `evaluation_answers` rows (one per scorecard question)
 * rendered as a small definition list.
 *
 * The answer value picker mirrors the typed-column convention in the
 * `evaluation_answers` table (see ADR-010 / migration
 * 20260418220000): one typed column per question-type, raw_data for
 * replay.
 */
import type { createClient } from '@/lib/supabase/server';

export interface EvaluationAnswerRow {
  id: string;
  question_tt_id: string;
  question_title: string | null;
  question_type: string | null;
  value_text: string | null;
  value_number: number | null;
  value_boolean: boolean | null;
  value_date: string | null;
  value_range: number | null;
}

export interface EvaluationRow {
  id: string;
  evaluator_name: string | null;
  score: number | null;
  decision: string | null;
  notes: string | null;
  created_at: string;
  evaluation_answers: EvaluationAnswerRow[];
}

export async function fetchEvaluations(
  supabase: ReturnType<typeof createClient>,
  candidateId: string,
): Promise<EvaluationRow[]> {
  const { data } = await supabase
    .from('evaluations')
    .select(
      'id, evaluator_name, score, decision, notes, created_at, ' +
        'evaluation_answers(id, question_tt_id, question_title, question_type, value_text, value_number, value_boolean, value_date, value_range)',
    )
    .eq('candidate_id', candidateId)
    .is('deleted_at', null)
    .order('created_at', { ascending: false });
  return (data ?? []) as unknown as EvaluationRow[];
}

function formatDate(iso: string): string | null {
  try {
    return new Date(iso).toISOString().slice(0, 10);
  } catch {
    return null;
  }
}

function answerValue(a: EvaluationAnswerRow): string {
  if (a.value_text && a.value_text.trim().length > 0) return a.value_text;
  if (a.value_number !== null) return a.value_number.toString();
  if (a.value_range !== null) return a.value_range.toString();
  if (a.value_boolean !== null) return a.value_boolean ? 'Yes' : 'No';
  if (a.value_date) return a.value_date;
  return '—';
}

function decisionBadgeClass(decision: string | null): string {
  switch (decision) {
    case 'accept':
      return 'bg-accent/10 text-accent';
    case 'reject':
      return 'bg-danger/10 text-danger';
    case 'on_hold':
      return 'bg-warning/10 text-warning';
    case 'pending':
      return 'bg-info/10 text-info';
    default:
      return 'bg-border text-text-muted';
  }
}

export function EvaluationsSection({ evaluations }: { evaluations: EvaluationRow[] }): JSX.Element {
  return (
    <section className="mb-6">
      <h2 className="mb-3 font-display text-base font-semibold text-text-primary">
        Evaluations{' '}
        <span className="font-mono text-xs font-normal text-text-muted">
          ({evaluations.length})
        </span>
      </h2>
      {evaluations.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-6 text-center">
          <p className="text-sm text-text-muted">Sin evaluaciones en este candidate.</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {evaluations.map((e) => (
            <li key={e.id} className="rounded-md border border-border bg-surface p-4">
              <div className="mb-2 flex flex-wrap items-center gap-3">
                <span
                  className={`inline-flex h-6 items-center rounded-sm px-2 font-mono text-[10px] uppercase tracking-widest ${decisionBadgeClass(e.decision)}`}
                >
                  {e.decision ?? 'unknown'}
                </span>
                {e.score !== null && (
                  <span className="font-mono text-xs text-text-primary">score: {e.score}</span>
                )}
                {e.evaluator_name && (
                  <span className="text-xs text-text-muted">por {e.evaluator_name}</span>
                )}
                <span className="ml-auto font-mono text-xs text-text-muted">
                  {formatDate(e.created_at)}
                </span>
              </div>
              {e.notes && (
                <p className="mb-2 whitespace-pre-wrap text-sm text-text-primary">{e.notes}</p>
              )}
              {e.evaluation_answers.length > 0 && (
                <dl className="mt-3 grid gap-x-6 gap-y-2 border-t border-border pt-3 sm:grid-cols-2">
                  {e.evaluation_answers.map((a) => (
                    <div key={a.id} className="flex min-w-0 flex-col gap-0.5">
                      <dt className="text-xs text-text-muted">
                        {a.question_title ?? a.question_tt_id}
                      </dt>
                      <dd className="break-words font-mono text-xs text-text-primary">
                        {answerValue(a)}
                      </dd>
                    </div>
                  ))}
                </dl>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
