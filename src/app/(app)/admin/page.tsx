/**
 * Admin landing — role-gated index of admin tools. A recruiter
 * hitting this URL is redirected to /403 by `requireRole`. Each
 * subsection is its own page; this file is just the index.
 */
import Link from 'next/link';

import { requireRole } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { countSyncErrors } from '@/lib/sync-errors/service';

export const metadata = {
  title: 'Admin — Recruitment Data Platform',
};

export const dynamic = 'force-dynamic';

export default async function AdminPage(): Promise<JSX.Element> {
  await requireRole('admin');
  const supabase = createClient();
  const unresolvedSyncErrors = await countSyncErrors(supabase).catch(() => 0);

  return (
    <div className="mx-auto max-w-4xl">
      <header className="mb-8">
        <h1 className="font-display text-2xl font-semibold tracking-tighter text-text-primary">
          Admin
        </h1>
        <p className="mt-1 text-sm text-text-muted">
          Operator tools: sync health, data quality, user management.
        </p>
      </header>
      <section className="grid gap-3 sm:grid-cols-2">
        <Link
          href="/admin/sync-errors"
          className="rounded-lg border border-border bg-surface p-5 transition-colors hover:border-accent/40"
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="font-display text-sm font-semibold text-text-primary">Sync errors</h2>
              <p className="mt-1 text-xs text-text-muted">
                ETL row failures. Investigate, fix, resolve.
              </p>
            </div>
            <span
              className={
                unresolvedSyncErrors > 0
                  ? 'rounded-full bg-danger/10 px-2 py-0.5 font-mono text-[10px] font-medium text-danger'
                  : 'rounded-full bg-bg px-2 py-0.5 font-mono text-[10px] text-text-muted'
              }
            >
              {unresolvedSyncErrors} open
            </span>
          </div>
        </Link>
      </section>
    </div>
  );
}
