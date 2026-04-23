/**
 * `/matching/runs/:id` — run detail (UC-11, F4-009).
 *
 * Server-rendered. RLS (ADR-017) scopes visibility to the recruiter
 * who triggered the run (or admin). Missing row → 404.
 *
 * Loads run metadata + up to 50 results + hydrates candidate display
 * fields in a single RLS-scoped pass.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import type { RequirementBreakdown } from '@/lib/matching/types';
import type { ResolvedDecomposition } from '@/lib/rag/decomposition/resolve-requirements';
import { createClient } from '@/lib/supabase/server';

import { JobQueryPanel } from './job-query-panel';
import { ResultsTable, type DisplayResult } from './results-table';

export const dynamic = 'force-dynamic';

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const RESULTS_LIMIT = 50;

interface PageProps {
  params: { id: string };
}

interface BreakdownJson {
  breakdown: RequirementBreakdown[];
  language_match: { required: number; matched: number };
  seniority_match: 'match' | 'below' | 'above' | 'unknown';
}

export async function generateMetadata({ params }: PageProps): Promise<{ title: string }> {
  return { title: `Match run ${params.id.slice(0, 8)} — Recruitment Data Platform` };
}

export default async function MatchRunPage({ params }: PageProps): Promise<JSX.Element> {
  if (!UUID_RE.test(params.id)) notFound();
  const supabase = createClient();

  const { data: run } = await supabase
    .from('match_runs')
    .select(
      'id, job_query_id, status, started_at, finished_at, candidates_evaluated, diagnostics, catalog_snapshot_at',
    )
    .eq('id', params.id)
    .maybeSingle();

  if (!run) notFound();

  // JD header: raw_text + decomposed requirements come from the
  // parent `job_queries` row. RLS already admits us via match_runs.
  const { data: jobQuery } = await supabase
    .from('job_queries')
    .select('raw_text, raw_text_retained, resolved_json, unresolved_skills')
    .eq('id', run.job_query_id as string)
    .maybeSingle();

  // Only surface gate=passed in the default view. Gate-failed
  // candidates (partial must-have coverage) stay out of the ranking
  // table; rescues-from-parsed-text bucket is the separate page.
  const { data: resultsRaw, count } = await supabase
    .from('match_results')
    .select('candidate_id, total_score, must_have_gate, rank, breakdown_json', {
      count: 'exact',
    })
    .eq('match_run_id', params.id)
    .eq('must_have_gate', 'passed')
    .order('rank', { ascending: true })
    .range(0, RESULTS_LIMIT - 1);

  const results = resultsRaw ?? [];
  const candidateIds = results.map((r) => r.candidate_id as string);

  const hydrated = new Map<string, { name: string | null; email: string | null }>();
  if (candidateIds.length > 0) {
    const { data: cands } = await supabase
      .from('candidates')
      .select('id, first_name, last_name, email')
      .in('id', candidateIds);
    for (const c of cands ?? []) {
      const first = (c.first_name as string | null) ?? '';
      const last = (c.last_name as string | null) ?? '';
      const name = `${first} ${last}`.trim() || null;
      hydrated.set(c.id as string, { name, email: (c.email as string | null) ?? null });
    }
  }

  const rows: DisplayResult[] = results.map((r) => {
    const b = (r.breakdown_json ?? {}) as Partial<BreakdownJson>;
    const meta = hydrated.get(r.candidate_id as string) ?? { name: null, email: null };
    return {
      candidate_id: r.candidate_id as string,
      rank: r.rank as number,
      total_score: r.total_score as number,
      must_have_gate: r.must_have_gate as 'passed' | 'failed',
      breakdown: b.breakdown ?? [],
      language_match: b.language_match ?? { required: 0, matched: 0 },
      seniority_match: b.seniority_match ?? 'unknown',
      candidate_name: meta.name,
      candidate_email: meta.email,
    };
  });

  const { count: rescuesCount } = await supabase
    .from('match_rescues')
    .select('candidate_id', { count: 'exact', head: true })
    .eq('match_run_id', params.id);

  return (
    <div className="mx-auto max-w-5xl">
      <header className="mb-6 flex items-baseline justify-between gap-4">
        <div>
          <p className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            match run · {params.id.slice(0, 8)}
          </p>
          <h1 className="mt-1 font-display text-2xl font-semibold tracking-tighter text-text-primary">
            {labelForStatus(run.status as string)}
          </h1>
        </div>
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          <Link
            href="/matching/new"
            className="rounded border border-border bg-surface px-2 py-1 text-text-primary hover:border-accent"
          >
            ← new match
          </Link>
          <Link
            href={`/matching/runs/${params.id}/rescues`}
            className="rounded border border-border bg-surface px-2 py-1 text-text-primary hover:border-accent"
          >
            rescues {rescuesCount !== null ? `(${rescuesCount})` : ''}
          </Link>
        </div>
      </header>

      <section className="mb-6 grid gap-2 rounded-lg border border-border bg-surface p-4 text-xs sm:grid-cols-4">
        <MetaCell label="status" value={run.status as string} />
        <MetaCell
          label="candidates"
          value={String((run.candidates_evaluated as number | null) ?? rows.length)}
        />
        <MetaCell label="passed" value={`${rows.length}/${count ?? rows.length}`} />
        <MetaCell label="started" value={shortTs(run.started_at as string | null)} />
      </section>

      <JobQueryPanel
        rawText={
          jobQuery && (jobQuery.raw_text_retained as boolean)
            ? ((jobQuery.raw_text as string | null) ?? null)
            : null
        }
        resolved={(jobQuery?.resolved_json as ResolvedDecomposition | null) ?? null}
        unresolvedSkills={(jobQuery?.unresolved_skills as string[] | null) ?? []}
      />

      <ResultsTable runId={params.id} rows={rows} />
    </div>
  );
}

function MetaCell({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-bg px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="truncate text-sm text-text-primary">{value}</span>
    </div>
  );
}

function labelForStatus(status: string): string {
  if (status === 'completed') return 'Results';
  if (status === 'running') return 'Running…';
  if (status === 'failed') return 'Failed';
  return status;
}

function shortTs(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace('T', ' ').slice(0, 16);
}
