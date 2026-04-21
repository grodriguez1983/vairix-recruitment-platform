/**
 * `/matching/runs/:id/rescues` — rescue bucket (ADR-016 §1, F4-009).
 *
 * Shows candidates that failed the must-have gate but whose parsed
 * CV text shows FTS evidence of the missing skills above
 * `FTS_RESCUE_THRESHOLD`. Sorted by `fts_max_rank` desc.
 *
 * Visibility scoped by RLS (migration 20260421000005). 404 when the
 * parent run isn't visible.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { createClient } from '@/lib/supabase/server';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

interface PageProps {
  params: { id: string };
}

interface RescueRow {
  candidate_id: string;
  missing_skills: string[];
  fts_snippets: Record<string, string[]>;
  fts_max_rank: number;
}

export async function generateMetadata({ params }: PageProps): Promise<{ title: string }> {
  return { title: `Rescues ${params.id.slice(0, 8)} — Recruitment Data Platform` };
}

export default async function RescuesPage({ params }: PageProps): Promise<JSX.Element> {
  if (!UUID_RE.test(params.id)) notFound();
  const supabase = createClient();

  const { data: run } = await supabase
    .from('match_runs')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (!run) notFound();

  const { data: rescuesRaw } = await supabase
    .from('match_rescues')
    .select('candidate_id, missing_skills, fts_snippets, fts_max_rank')
    .eq('match_run_id', params.id)
    .order('fts_max_rank', { ascending: false });

  const rescues = (rescuesRaw ?? []).map(
    (r): RescueRow => ({
      candidate_id: r.candidate_id as string,
      missing_skills: (r.missing_skills as string[] | null) ?? [],
      fts_snippets: (r.fts_snippets as Record<string, string[]> | null) ?? {},
      fts_max_rank: Number(r.fts_max_rank),
    }),
  );

  const hydrated = new Map<string, { name: string | null; email: string | null }>();
  const ids = rescues.map((r) => r.candidate_id);
  if (ids.length > 0) {
    const { data: cands } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, email')
      .in('id', ids);
    for (const c of cands ?? []) {
      const first = (c.first_name as string | null) ?? '';
      const last = (c.last_name as string | null) ?? '';
      const name = `${first} ${last}`.trim() || null;
      hydrated.set(c.id as string, { name, email: (c.email as string | null) ?? null });
    }
  }

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            rescue bucket · {params.id.slice(0, 8)}
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tighter text-text-primary">
            FTS fallback
          </h1>
          <p className="mt-1 text-sm text-text-muted">
            Gate-failed candidates with CV-text evidence of missing must-haves. Requires manual
            review — score and rank are not affected (ADR-016 §1).
          </p>
        </div>
        <Link
          href={`/matching/runs/${params.id}`}
          className="rounded border border-border bg-surface px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-text-primary hover:border-accent"
        >
          ← results
        </Link>
      </header>

      {rescues.length === 0 ? (
        <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">
            No rescues. The LLM either caught every must-have or there&apos;s no textual evidence
            above threshold.
          </p>
        </section>
      ) : (
        <ul className="flex flex-col gap-3">
          {rescues.map((r) => {
            const meta = hydrated.get(r.candidate_id);
            return (
              <li
                key={r.candidate_id}
                className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
              >
                <div className="flex items-baseline justify-between gap-3">
                  <Link
                    href={`/candidates/${r.candidate_id}`}
                    className="truncate font-display text-base font-medium text-text-primary hover:text-accent"
                  >
                    {meta?.name ?? meta?.email ?? r.candidate_id.slice(0, 8)}
                  </Link>
                  <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                    ts_rank {r.fts_max_rank.toFixed(3)}
                  </span>
                </div>

                <div className="flex flex-col gap-2">
                  {r.missing_skills.map((slug) => {
                    const snips = r.fts_snippets[slug] ?? [];
                    return (
                      <div key={slug} className="rounded-md border border-border bg-bg p-3">
                        <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-accent">
                          {slug}
                        </p>
                        {snips.length === 0 ? (
                          <p className="font-mono text-[11px] text-text-muted">no snippet</p>
                        ) : (
                          <ul className="flex flex-col gap-1">
                            {snips.map((s, i) => (
                              <li
                                key={i}
                                className="font-mono text-[11px] leading-snug text-text-primary"
                                dangerouslySetInnerHTML={{ __html: highlightSnippet(s) }}
                              />
                            ))}
                          </ul>
                        )}
                      </div>
                    );
                  })}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/**
 * The RPC returns snippets with `«` / `»` as StartSel/StopSel.
 * Escape the snippet and re-wrap matches in <mark>.
 */
function highlightSnippet(raw: string): string {
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/«/g, '<mark class="bg-accent/20 text-accent px-0.5 rounded">')
    .replace(/»/g, '</mark>');
}
