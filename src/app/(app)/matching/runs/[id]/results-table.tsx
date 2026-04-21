/**
 * `/matching/runs/:id` — client results table with inline breakdown.
 *
 * Pure display of pre-hydrated rows. Clicking a row toggles the
 * breakdown drawer for that candidate. No fetch on the client —
 * every row came from the server component under RLS.
 */
'use client';

import Link from 'next/link';
import { useState } from 'react';

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

export function ResultsTable({ rows }: { rows: DisplayResult[] }): JSX.Element {
  const [expanded, setExpanded] = useState<string | null>(null);

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

            {open && <BreakdownPanel row={r} />}
          </li>
        );
      })}
    </ul>
  );
}

function BreakdownPanel({ row }: { row: DisplayResult }): JSX.Element {
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
    </div>
  );
}
