/**
 * Client editor for a single skill row (ADR-013 §6).
 *
 * - Edit canonical_name / category (slug is immutable).
 * - Deprecate / undeprecate.
 * - Add an alias (source='admin') or remove an existing alias
 *   (seed/derived aliases can be removed but it's logged in source
 *   so the admin knows they're touching provenance).
 */
'use client';

import { useState, useTransition } from 'react';

import type { SkillDetail } from '@/lib/skills/admin-service';

import {
  addAliasAction,
  removeAliasAction,
  setDeprecatedAction,
  updateSkillAction,
} from '../actions';

interface Props {
  skill: SkillDetail;
}

export function SkillEditor({ skill }: Props): JSX.Element {
  const [isPending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const [canonical, setCanonical] = useState(skill.canonical_name);
  const [category, setCategory] = useState(skill.category ?? '');
  const [newAlias, setNewAlias] = useState('');

  function flash(message: string): void {
    setStatus(message);
    setError(null);
  }
  function fail(message: string): void {
    setError(message);
    setStatus(null);
  }

  function onSaveMeta(): void {
    startTransition(async () => {
      const res = await updateSkillAction(skill.id, {
        canonical_name: canonical,
        category: category.trim() === '' ? null : category,
      });
      if (!res.ok) return fail(res.error?.message ?? 'failed');
      flash('saved');
    });
  }

  function onToggleDeprecated(): void {
    startTransition(async () => {
      const res = await setDeprecatedAction(skill.id, skill.deprecated_at === null);
      if (!res.ok) return fail(res.error?.message ?? 'failed');
      flash(skill.deprecated_at === null ? 'deprecated' : 'restored');
    });
  }

  function onAddAlias(): void {
    if (newAlias.trim() === '') return fail('alias cannot be empty');
    startTransition(async () => {
      const res = await addAliasAction(skill.id, newAlias);
      if (!res.ok) return fail(res.error?.message ?? 'failed');
      flash('alias added');
      setNewAlias('');
    });
  }

  function onRemoveAlias(aliasId: string): void {
    startTransition(async () => {
      const res = await removeAliasAction(skill.id, aliasId);
      if (!res.ok) return fail(res.error?.message ?? 'failed');
      flash('alias removed');
    });
  }

  return (
    <div className="flex flex-col gap-6">
      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          metadata
        </h2>
        <div className="flex flex-col gap-3">
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              canonical name
            </span>
            <input
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              disabled={isPending}
              className="rounded border border-border bg-bg px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <label className="flex flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              category (optional)
            </span>
            <input
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              disabled={isPending}
              className="rounded border border-border bg-bg px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={onSaveMeta}
              disabled={isPending}
              className="rounded border border-accent bg-accent/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-accent hover:bg-accent/20 disabled:opacity-50"
            >
              {isPending ? '…' : 'save'}
            </button>
            <button
              type="button"
              onClick={onToggleDeprecated}
              disabled={isPending}
              className="rounded border border-border bg-bg px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-text-muted hover:text-text-primary disabled:opacity-50"
            >
              {skill.deprecated_at ? 'undeprecate' : 'deprecate'}
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-border bg-surface p-4">
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-wider text-text-muted">
          aliases ({skill.aliases.length})
        </h2>
        <div className="mb-3 flex items-end gap-2">
          <label className="flex flex-1 flex-col gap-1">
            <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
              add alias
            </span>
            <input
              value={newAlias}
              onChange={(e) => setNewAlias(e.target.value)}
              disabled={isPending}
              placeholder="e.g. reactjs"
              className="rounded border border-border bg-bg px-2 py-1 text-sm text-text-primary focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-50"
            />
          </label>
          <button
            type="button"
            onClick={onAddAlias}
            disabled={isPending || newAlias.trim() === ''}
            className="rounded border border-accent bg-accent/10 px-3 py-1 font-mono text-[10px] uppercase tracking-wider text-accent hover:bg-accent/20 disabled:opacity-50"
          >
            add
          </button>
        </div>
        {skill.aliases.length === 0 ? (
          <p className="font-mono text-[11px] text-text-muted">
            No aliases yet. The slug itself resolves automatically.
          </p>
        ) : (
          <ul className="flex flex-col divide-y divide-border">
            {skill.aliases.map((a) => (
              <li key={a.id} className="flex items-center justify-between gap-3 py-2">
                <div className="min-w-0 flex-1">
                  <p className="font-mono text-sm text-text-primary">{a.alias_normalized}</p>
                  <p className="font-mono text-[10px] text-text-muted">
                    source: {a.source} · added {a.created_at.slice(0, 10)}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => onRemoveAlias(a.id)}
                  disabled={isPending}
                  className="rounded border border-border bg-bg px-2 py-1 font-mono text-[10px] uppercase tracking-wider text-danger hover:bg-danger/10 disabled:opacity-50"
                >
                  remove
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      {error && (
        <p role="alert" className="font-mono text-[11px] text-danger">
          {error}
        </p>
      )}
      {status && !error && <p className="font-mono text-[11px] text-accent">{status}</p>}
    </div>
  );
}
