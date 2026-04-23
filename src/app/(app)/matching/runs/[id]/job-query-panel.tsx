/**
 * JD header panel for `/matching/runs/:id` — shows the original raw
 * text (collapsible) and the decomposed requirements as tags.
 *
 * Server-rendered: receives the `job_queries` row already hydrated
 * from the page. No client interactivity beyond the <details>
 * element (native, no JS needed).
 */
import type { ResolvedDecomposition } from '@/lib/rag/decomposition/resolve-requirements';

import { cn } from '@/lib/shared/cn';

interface Props {
  rawText: string | null;
  resolved: ResolvedDecomposition | null;
  unresolvedSkills: string[];
}

export function JobQueryPanel({ rawText, resolved, unresolvedSkills }: Props): JSX.Element {
  const requirements = resolved?.requirements ?? [];
  // Bucket by alternative_group_id so OR-groups render together.
  // `null` is a synthetic singleton per-row; use the requirement index
  // as the bucket key to keep each such row on its own line.
  const groups = new Map<string, typeof requirements>();
  requirements.forEach((r, i) => {
    const key = r.alternative_group_id ?? `__single_${i}`;
    const bucket = groups.get(key);
    if (bucket) bucket.push(r);
    else groups.set(key, [r]);
  });
  const groupsOrdered = Array.from(groups.entries());

  return (
    <section className="mb-6 flex flex-col gap-4 rounded-lg border border-border bg-surface p-4">
      <div>
        <div className="mb-2 flex items-center justify-between">
          <h2 className="font-mono text-[10px] uppercase tracking-widest text-text-muted">
            original JD
          </h2>
          {rawText && (
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              {rawText.length.toLocaleString()} chars
            </span>
          )}
        </div>
        {rawText ? (
          <details className="group rounded-md border border-border bg-bg">
            <summary className="cursor-pointer list-none px-3 py-2 font-mono text-[11px] uppercase tracking-wider text-text-muted hover:text-text-primary">
              <span className="group-open:hidden">▸ show raw text</span>
              <span className="hidden group-open:inline">▾ hide raw text</span>
            </summary>
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap border-t border-border px-3 py-2 font-sans text-xs leading-relaxed text-text-primary">
              {rawText}
            </pre>
          </details>
        ) : (
          <p className="text-xs text-text-muted">raw text not retained</p>
        )}
      </div>

      {groupsOrdered.length > 0 && (
        <div>
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-text-muted">
            extracted requirements · {requirements.length}
          </h2>
          <ul className="flex flex-col gap-1.5">
            {groupsOrdered.map(([key, bucket]) => (
              <li key={key} className="flex flex-wrap items-center gap-1.5">
                {bucket.map((r, i) => (
                  <span key={`${key}-${i}`} className="contents">
                    {i > 0 && (
                      <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
                        or
                      </span>
                    )}
                    <RequirementTag req={r} />
                  </span>
                ))}
              </li>
            ))}
          </ul>
        </div>
      )}

      {(resolved?.role_essentials.length ?? 0) > 0 && (
        <div>
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-text-muted">
            role essentials (ADR-023)
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {resolved!.role_essentials.map((g) => (
              <li
                key={g.label}
                className={cn(
                  'rounded border px-2 py-0.5 font-mono text-[10px] uppercase tracking-wider',
                  g.skill_ids.length > 0
                    ? 'border-accent/30 bg-accent/5 text-accent'
                    : 'border-border bg-bg text-text-muted',
                )}
              >
                {g.label} · {g.skill_ids.length}
              </li>
            ))}
          </ul>
        </div>
      )}

      {unresolvedSkills.length > 0 && (
        <div>
          <h2 className="mb-2 font-mono text-[10px] uppercase tracking-widest text-text-muted">
            unresolved · {unresolvedSkills.length}
          </h2>
          <ul className="flex flex-wrap gap-1.5">
            {unresolvedSkills.map((s) => (
              <li
                key={s}
                className="rounded border border-danger/30 bg-danger/5 px-2 py-0.5 font-mono text-[10px] text-danger"
                title="skill not in the catalog — will not count in scoring"
              >
                {s}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function RequirementTag({
  req,
}: {
  req: ResolvedDecomposition['requirements'][number];
}): JSX.Element {
  const resolved = req.skill_id !== null;
  const yrs =
    req.min_years !== null
      ? req.max_years !== null
        ? `${req.min_years}–${req.max_years}y`
        : `${req.min_years}+y`
      : null;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded border px-2 py-0.5 text-xs',
        resolved
          ? 'border-border bg-bg text-text-primary'
          : 'border-danger/30 bg-danger/5 text-danger',
      )}
      title={req.evidence_snippet ?? undefined}
    >
      {req.must_have && (
        <span className="font-mono text-[9px] uppercase tracking-wider text-accent">must</span>
      )}
      <span className="font-medium">{req.skill_raw}</span>
      {yrs && (
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          {yrs}
        </span>
      )}
      {!resolved && (
        <span className="font-mono text-[9px] uppercase tracking-wider" title="not in catalog">
          ✕
        </span>
      )}
    </span>
  );
}
