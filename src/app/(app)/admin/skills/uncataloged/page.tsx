/**
 * `/admin/skills/uncataloged` — operator view of `experience_skills`
 * rows with `skill_id IS NULL`, grouped by normalized form
 * (ADR-013 §5).
 *
 * Admin-only (`requireRole('admin')`). Each row exposes two
 * actions: promote the alias to a full catalog entry, or blacklist
 * it so it disappears from the report.
 */
import Link from 'next/link';

import { requireRole } from '@/lib/auth/require';
import { listUncataloged } from '@/lib/skills/uncataloged';
import { createClient } from '@/lib/supabase/server';

import { UncatalogedRowActions } from './uncataloged-row';

export const metadata = {
  title: 'Uncataloged skills — Admin',
};

export const dynamic = 'force-dynamic';

export default async function UncatalogedSkillsPage(): Promise<JSX.Element> {
  await requireRole('admin');
  const db = createClient();

  const { groups, truncated } = await listUncataloged(db).catch(() => ({
    groups: [],
    truncated: false,
  }));

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-6">
        <Link href="/admin" className="font-mono text-xs text-text-muted hover:text-text-primary">
          ← Admin
        </Link>
        <h1 className="mt-2 font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Uncataloged skills
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Skill strings the CV extractor surfaced that the catalog does not resolve. Promote genuine
          skills into <span className="font-mono text-xs">skills</span> (the incremental reconcile
          runs automatically) or blacklist the string if it is not a real skill (e.g.{' '}
          <span className="font-mono text-xs">team player</span>).
        </p>
      </header>

      <section className="mb-4 flex items-center justify-between rounded-lg border border-border bg-surface p-3 font-mono text-[11px] text-text-muted">
        <span>
          {groups.length} distinct alias{groups.length === 1 ? '' : 'es'}
        </span>
        {truncated && (
          <span className="text-warning">
            result truncated — blacklist obvious junk to see the long tail
          </span>
        )}
      </section>

      {groups.length === 0 ? (
        <div className="rounded-lg border border-border border-dashed bg-surface p-8 text-center">
          <p className="text-sm text-text-muted">Nothing to review. 🎉</p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {groups.map((g) => (
            <li key={g.alias_normalized} className="rounded-md border border-border bg-surface p-4">
              <UncatalogedRowActions
                aliasNormalized={g.alias_normalized}
                count={g.count}
                samples={g.samples}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
