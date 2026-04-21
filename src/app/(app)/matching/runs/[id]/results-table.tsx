/**
 * `/matching/runs/:id` — client results table with inline breakdown
 * + lazy-loaded evidence panel (ADR-016 §2).
 *
 * Rows arrive pre-hydrated from the server under RLS. Clicking a
 * row toggles the drawer; the evidence panel fetches lazily on
 * first open per candidate and caches the result in local state.
 */
'use client';

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { cn } from '@/lib/shared/cn';
import type { CandidateScore, RequirementBreakdown } from '@/lib/matching/types';

export interface DisplayResult {
  candidate_id: string;
  rank: number;
  total_score: number;
  must_have_gate: 'passed' | 'failed';
  breakdown: RequirementBreakdown[];
  language_match: CandidateScore['language_match'];
  seniority_match: CandidateScore['seniority_match'];
  candidate_name: string | null;
  candidate_email: string | null;
}

interface EvidenceState {
  status: 'loading' | 'ok' | 'error';
  snippets?: Record<string, string[]>;
  message?: string;
}

export function ResultsTable({
  runId,
  rows,
}: {
  runId: string;
  rows: DisplayResult[];
}): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);
  const [evidence, setEvidence] = useState<Record<string, EvidenceState>>({});

  if (rows.length === 0) {
    return (
      <section className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
        <p className="text-sm text-text-muted">No candidates scored.</p>
      </section>
    );
  }

  return (
    <ul className="flex flex-col gap-2">
      {rows.map((r) => {
        const open = expanded === r.candidate_id;
        return (
          <li
            key={r.candidate_id}
            className="flex flex-col rounded-lg border border-border bg-surface"
          >
            <button
              type="button"
              onClick={() => setExpanded(open ? null : r.candidate_id)}
              className="flex items-center gap-4 px-4 py-3 text-left hover:bg-bg"
            >
              <span className="w-8 shrink-0 font-mono text-xs text-text-muted">#{r.rank}</span>
              <span className="flex-1 truncate text-sm text-text-primary">
                {r.candidate_name ?? r.candidate_email ?? r.candidate_id.slice(0, 8)}
              </span>
              <span
                className={cn(
                  'rounded px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
                  r.must_have_gate === 'passed'
                    ? 'bg-accent/10 text-accent'
                    : 'bg-danger/10 text-danger',
                )}
              >
                {r.must_have_gate}
              </span>
              <span className="w-14 text-right font-mono text-sm tabular-nums text-text-primary">
                {r.total_score.toFixed(1)}
              </span>
              <span className="w-4 shrink-0 font-mono text-xs text-text-muted">
                {open ? '▾' : '▸'}
              </span>
            </button>

            {open && (
              <BreakdownPanel
                row={r}
                runId={runId}
                evidence={evidence[r.candidate_id]}
                onEvidenceLoaded={(state) =>
                  setEvidence((prev) => ({ ...prev, [r.candidate_id]: state }))
                }
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

function BreakdownPanel({
  row,
  runId,
  evidence,
  onEvidenceLoaded,
}: {
  row: DisplayResult;
  runId: string;
  evidence: EvidenceState | undefined;
  onEvidenceLoaded: (state: EvidenceState) => void;
}): JSX.Element {
  useEffect(() => {
    if (evidence !== undefined) return;
    let cancelled = false;
    onEvidenceLoaded({ status: 'loading' });
    (async () => {
      try {
        const res = await fetch(
          `/api/matching/runs/${runId}/evidence?candidate_id=${row.candidate_id}`,
        );
        const body = (await res.json().catch(() => ({}))) as {
          snippets?: Record<string, string[]>;
          error?: string;
          message?: string;
        };
        if (cancelled) return;
        if (!res.ok) {
          onEvidenceLoaded({
            status: 'error',
            message: body.message ?? body.error ?? `evidence fetch failed (${res.status})`,
          });
          return;
        }
        onEvidenceLoaded({ status: 'ok', snippets: body.snippets ?? {} });
      } catch (err) {
        if (cancelled) return;
        onEvidenceLoaded({
          status: 'error',
          message: err instanceof Error ? err.message : String(err),
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [row.candidate_id, runId, evidence, onEvidenceLoaded]);

  return (
    <div className="flex flex-col gap-3 border-t border-border bg-bg px-4 py-3">
      <div className="flex flex-wrap gap-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        <span className="rounded border border-border bg-surface px-2 py-0.5">
          languages {row.language_match.matched}/{row.language_match.required}
        </span>
        <span className="rounded border border-border bg-surface px-2 py-0.5">
          seniority {row.seniority_match}
        </span>
        <Link
          href={`/candidates/${row.candidate_id}`}
          className="ml-auto rounded border border-border bg-surface px-2 py-0.5 text-text-primary hover:border-accent"
        >
          open profile →
        </Link>
      </div>

      <table className="w-full text-left font-mono text-[11px]">
        <thead>
          <tr className="border-b border-border text-text-muted">
            <th className="py-1 pr-2 font-normal uppercase tracking-wider">skill</th>
            <th className="py-1 pr-2 font-normal uppercase tracking-wider">status</th>
            <th className="py-1 pr-2 font-normal uppercase tracking-wider">years</th>
            <th className="py-1 pr-2 font-normal uppercase tracking-wider">ratio</th>
            <th className="py-1 pr-2 text-right font-normal uppercase tracking-wider">contrib</th>
          </tr>
        </thead>
        <tbody>
          {row.breakdown.map((b, i) => (
            <tr
              key={`${b.requirement.skill_raw}-${i}`}
              className="border-b border-border/50 align-top last:border-0"
            >
              <td className="py-1 pr-2 text-text-primary">
                {b.requirement.skill_raw}
                {b.requirement.must_have && (
                  <span className="ml-1 rounded bg-danger/10 px-1 py-0 text-[9px] text-danger">
                    must
                  </span>
                )}
                {b.requirement.skill_id === null && (
                  <span className="ml-1 rounded bg-surface px-1 py-0 text-[9px] text-text-muted">
                    unresolved
                  </span>
                )}
                {b.evidence.length > 0 && (
                  <span className="mt-0.5 block text-[10px] text-text-muted">
                    {b.evidence
                      .slice(0, 2)
                      .map((e) => `${e.company ?? '?'} · ${e.date_range}`)
                      .join(' / ')}
                    {b.evidence.length > 2 ? ` · +${b.evidence.length - 2}` : ''}
                  </span>
                )}
              </td>
              <td className="py-1 pr-2 text-text-muted">{b.status}</td>
              <td className="py-1 pr-2 text-text-muted tabular-nums">
                {b.candidate_years.toFixed(1)}
              </td>
              <td className="py-1 pr-2 text-text-muted tabular-nums">{b.years_ratio.toFixed(2)}</td>
              <td className="py-1 pr-2 text-right text-text-primary tabular-nums">
                {b.contribution.toFixed(1)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <EvidenceSection evidence={evidence} />
    </div>
  );
}

function EvidenceSection({ evidence }: { evidence: EvidenceState | undefined }): JSX.Element {
  if (evidence === undefined || evidence.status === 'loading') {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface p-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          evidence · loading…
        </p>
      </div>
    );
  }
  if (evidence.status === 'error') {
    return (
      <div className="rounded-md border border-danger/40 bg-danger/5 p-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-danger">
          evidence failed
        </p>
        <p className="mt-0.5 font-mono text-[11px] text-danger">{evidence.message}</p>
      </div>
    );
  }
  const snippets = evidence.snippets ?? {};
  const skills = Object.keys(snippets).sort();
  if (skills.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface p-3">
        <p className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          evidence · no textual matches
        </p>
      </div>
    );
  }
  return (
    <div className="rounded-md border border-border bg-surface p-3">
      <p className="mb-2 font-mono text-[10px] uppercase tracking-wider text-text-muted">
        evidence
      </p>
      <ul className="flex flex-col gap-2">
        {skills.map((slug) => {
          const list = snippets[slug] ?? [];
          return (
            <li key={slug} className="flex flex-col gap-1">
              <p className="font-mono text-[10px] uppercase tracking-wider text-accent">{slug}</p>
              <ul className="flex flex-col gap-1">
                {list.map((s, i) => (
                  <li
                    key={i}
                    className="font-mono text-[11px] leading-snug text-text-primary"
                    dangerouslySetInnerHTML={{ __html: highlightSnippet(s) }}
                  />
                ))}
              </ul>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/**
 * Mirrors the rescues page: match_rescue_fts_search returns
 * snippets with «…» as StartSel/StopSel.
 */
function highlightSnippet(raw: string): string {
  const escaped = raw.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  return escaped
    .replace(/«/g, '<mark class="bg-accent/20 text-accent px-0.5 rounded">')
    .replace(/»/g, '</mark>');
}
