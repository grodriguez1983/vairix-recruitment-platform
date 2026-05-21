/**
 * `/matching/new` — client form (UC-11, F4-009).
 *
 * Two-stage flow, both stages hit existing JSON APIs:
 *
 *   1. Paste JD → POST `/api/matching/decompose` → show resolved
 *      requirements + unresolved skills + seniority + languages.
 *   2. Click "Run match" → ADR-034 FE-driven chunked pipeline:
 *         POST `/api/matching/run/start`        (open run + preFilter)
 *         POST `/api/matching/run/process-chunk` × ceil(total/CHUNK)
 *         POST `/api/matching/run/finalize`     (close + top_n)
 *      Then redirect to `/matching/runs/:id`.
 *
 * No local business logic beyond shape narrowing: the server is the
 * source of truth for validation (Zod on every route) and RLS.
 *
 * Heroku H12 = 30s. The chunk loop is what keeps each request below
 * that ceiling — chunk size is conservative so loadCandidates +
 * rank + insert fit comfortably.
 */
'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

import { cn } from '@/lib/shared/cn';
import type { ResolvedDecomposition } from '@/lib/rag/decomposition/resolve-requirements';

interface DecomposeResponse {
  query_id: string;
  cached: boolean;
  resolved: ResolvedDecomposition;
  unresolved_skills: string[];
}

interface PreFilterExcluded {
  candidate_id: string;
  missing_must_have_skill_ids: string[];
}

interface StartResponse {
  run_id: string;
  included: string[];
  excluded: PreFilterExcluded[];
  total: number;
  tenant_id: string | null;
}

interface ProcessChunkResponse {
  processed_count: number;
  total: number | null;
  new_results: unknown[];
}

interface FinalizeResponse {
  candidates_evaluated: number;
  top: unknown[];
  rescues_inserted?: number;
}

const MAX_JD = 20000;
/** Chunk size for /process-chunk. Conservative: loadCandidates over
 *  ~100 candidates + rank + insert fits comfortably under Heroku
 *  H12 (30s). Raise only with measurement. */
const CHUNK_SIZE = 100;
const TOP_N = 20;

interface ProgressState {
  phase: 'starting' | 'processing' | 'finalizing';
  processed: number;
  total: number;
}

export function NewMatchForm(): JSX.Element {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [rawText, setRawText] = useState('');
  const [decomposition, setDecomposition] = useState<DecomposeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<ProgressState | null>(null);

  async function onDecompose(e: React.FormEvent<HTMLFormElement>): Promise<void> {
    e.preventDefault();
    setError(null);
    setDecomposition(null);
    const text = rawText.trim();
    if (text.length === 0) {
      setError('Paste a job description first.');
      return;
    }
    startTransition(async () => {
      try {
        const res = await fetch('/api/matching/decompose', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ rawText: text }),
        });
        const body = (await res.json().catch(() => ({}))) as {
          error?: string;
          message?: string;
        } & DecomposeResponse;
        if (!res.ok) {
          setError(body.message ?? body.error ?? `decompose failed (${res.status})`);
          return;
        }
        setDecomposition(body);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    });
  }

  async function onRun(): Promise<void> {
    if (!decomposition) return;
    setError(null);
    setRunning(true);
    setProgress({ phase: 'starting', processed: 0, total: 0 });
    try {
      // 1. /start — opens run + runs preFilter + stamps expected_count.
      const startBody = await postJson<StartResponse>('/api/matching/run/start', {
        job_query_id: decomposition.query_id,
      });
      const { run_id, included, excluded, total } = startBody;
      setProgress({ phase: 'processing', processed: 0, total });

      // 2. /process-chunk loop — chunk-local rank, total_score-desc
      //    ordering is recovered on read (ADR-034 + migration 004).
      //    The post-bump processed_count returned by the server is
      //    what we display, so concurrent writers (if any) are
      //    observed truthfully.
      for (let i = 0; i < included.length; i += CHUNK_SIZE) {
        const chunk = included.slice(i, i + CHUNK_SIZE);
        const res = await postJson<ProcessChunkResponse>('/api/matching/run/process-chunk', {
          run_id,
          candidate_ids: chunk,
        });
        setProgress({
          phase: 'processing',
          processed: res.processed_count,
          total: res.total ?? total,
        });
      }

      // 3. /finalize — closes the run, returns top + rescues.
      setProgress({ phase: 'finalizing', processed: total, total });
      await postJson<FinalizeResponse>('/api/matching/run/finalize', {
        run_id,
        top_n: TOP_N,
        excluded,
      });

      router.push(`/matching/runs/${run_id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
      setProgress(null);
    }
  }

  return (
    <div className="flex flex-col gap-6">
      <form
        onSubmit={onDecompose}
        className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-4"
      >
        <label className="flex flex-col gap-1">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            job description
          </span>
          <textarea
            name="rawText"
            value={rawText}
            onChange={(e) => setRawText(e.target.value)}
            rows={10}
            maxLength={MAX_JD}
            placeholder="Paste the JD here. The decomposer extracts must-haves, years, seniority, and languages."
            className="min-h-[220px] rounded-md border border-border bg-bg px-3 py-2 text-sm text-text-primary placeholder:text-text-muted focus:outline-none focus:ring-1 focus:ring-accent"
          />
        </label>
        <div className="flex items-center justify-between">
          <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
            {rawText.length}/{MAX_JD}
          </span>
          <button
            type="submit"
            disabled={isPending}
            className={cn(
              'rounded-md border border-border bg-bg px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-text-primary',
              'hover:bg-surface disabled:opacity-50',
            )}
          >
            {isPending ? 'decomposing…' : 'decompose'}
          </button>
        </div>
      </form>

      {error && (
        <section className="rounded-lg border border-danger/40 bg-danger/5 p-4">
          <p className="font-mono text-xs text-danger">{error}</p>
        </section>
      )}

      {decomposition && (
        <DecompositionPanel
          data={decomposition}
          running={running}
          progress={progress}
          onRun={onRun}
        />
      )}
    </div>
  );
}

/**
 * Thin POST helper. Throws on non-2xx with the server's `message` /
 * `error` if present, so the caller can surface it in the form.
 */
async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const parsed = (await res.json().catch(() => ({}))) as { error?: string; message?: string } & T;
  if (!res.ok) {
    throw new Error(parsed.message ?? parsed.error ?? `${url} failed (${res.status})`);
  }
  return parsed;
}

function DecompositionPanel({
  data,
  running,
  progress,
  onRun,
}: {
  data: DecomposeResponse;
  running: boolean;
  progress: ProgressState | null;
  onRun: () => void;
}): JSX.Element {
  const { resolved, unresolved_skills, cached, query_id } = data;
  return (
    <section className="flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <header className="flex items-baseline justify-between">
        <h2 className="font-display text-lg font-semibold tracking-tight text-text-primary">
          Decomposition
        </h2>
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          {cached ? 'cache hit' : 'fresh'} · {query_id.slice(0, 8)}
        </span>
      </header>

      <div className="grid gap-3 sm:grid-cols-2">
        <MetaRow label="seniority" value={resolved.seniority} />
        <MetaRow
          label="languages"
          value={
            resolved.languages.length === 0
              ? '—'
              : resolved.languages
                  .map((l) => `${l.name} (${l.level}${l.must_have ? ', must' : ''})`)
                  .join(', ')
          }
        />
      </div>

      <div>
        <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          requirements ({resolved.requirements.length})
        </p>
        <ul className="flex flex-col divide-y divide-border rounded-md border border-border bg-bg">
          {resolved.requirements.map((r, i) => (
            <li
              key={`${r.skill_raw}-${i}`}
              className="flex items-start justify-between gap-3 px-3 py-2"
            >
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-text-primary">
                  {r.skill_raw}{' '}
                  <span className="font-mono text-[10px] text-text-muted">[{r.category}]</span>
                </p>
                <p className="mt-0.5 line-clamp-2 text-xs text-text-muted">
                  “{r.evidence_snippet}”
                </p>
              </div>
              <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] uppercase tracking-wider">
                {r.must_have && (
                  <span className="rounded bg-danger/10 px-1.5 py-0.5 text-danger">must</span>
                )}
                {(r.min_years !== null || r.max_years !== null) && (
                  <span className="rounded bg-surface px-1.5 py-0.5 text-text-muted">
                    {r.min_years ?? '?'}–{r.max_years ?? '?'}y
                  </span>
                )}
                <span
                  className={cn(
                    'rounded px-1.5 py-0.5',
                    r.skill_id !== null ? 'bg-accent/10 text-accent' : 'bg-surface text-text-muted',
                  )}
                >
                  {r.skill_id !== null ? 'resolved' : 'unresolved'}
                </span>
              </div>
            </li>
          ))}
        </ul>
      </div>

      {unresolved_skills.length > 0 && (
        <div className="rounded-md border border-warning/40 bg-warning/5 p-3">
          <p className="mb-1 font-mono text-[10px] uppercase tracking-wider text-warning">
            unresolved ({unresolved_skills.length})
          </p>
          <p className="text-xs text-text-muted">{unresolved_skills.join(', ')}</p>
        </div>
      )}

      <div className="flex items-center justify-end gap-3">
        {running && progress && <ProgressIndicator progress={progress} />}
        <button
          type="button"
          onClick={onRun}
          disabled={running}
          className={cn(
            'rounded-md border border-border bg-bg px-4 py-1.5 font-mono text-[10px] uppercase tracking-wider text-text-primary',
            'hover:bg-surface disabled:opacity-50',
          )}
        >
          {running ? 'running…' : 'run match'}
        </button>
      </div>
    </section>
  );
}

function ProgressIndicator({ progress }: { progress: ProgressState }): JSX.Element {
  const { phase, processed, total } = progress;
  const pct = total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0;
  const label =
    phase === 'starting'
      ? 'pre-filtering…'
      : phase === 'finalizing'
        ? 'finalizing…'
        : `${processed}/${total} (${pct}%)`;
  return (
    <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">{label}</span>
  );
}

function MetaRow({ label, value }: { label: string; value: string }): JSX.Element {
  return (
    <div className="flex flex-col gap-0.5 rounded-md border border-border bg-bg px-3 py-2">
      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
        {label}
      </span>
      <span className="text-sm text-text-primary">{value}</span>
    </div>
  );
}
