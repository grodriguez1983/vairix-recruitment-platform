/**
 * `/shortlists/[id]` — shortlist detail view (UC-03).
 *
 * Shows candidate list with per-row remove buttons, an archive
 * action, and a CSV export link. Archived shortlists are rendered
 * read-only: no add, no remove, no re-archive.
 */
import Link from 'next/link';
import { notFound } from 'next/navigation';

import { requireAuth } from '@/lib/auth/require';
import { getShortlist, listShortlistCandidates } from '@/lib/shortlists/service';
import { createClient } from '@/lib/supabase/server';

import { ShortlistDetail } from './shortlist-detail';

export const dynamic = 'force-dynamic';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({ params }: PageProps): Promise<{ title: string }> {
  return { title: `Shortlist ${params.id.slice(0, 8)} — Recruitment Data Platform` };
}

export default async function ShortlistDetailPage({ params }: PageProps): Promise<JSX.Element> {
  await requireAuth();
  if (!UUID_REGEX.test(params.id)) notFound();

  const supabase = createClient();
  const shortlist = await getShortlist(supabase, params.id);
  if (!shortlist) notFound();

  const candidates = await listShortlistCandidates(supabase, shortlist.id).catch(() => []);

  return (
    <div className="mx-auto max-w-4xl">
      <div className="mb-4">
        <Link
          href="/shortlists"
          className="text-xs font-medium text-text-muted hover:text-text-primary"
        >
          ← Back to shortlists
        </Link>
      </div>
      <ShortlistDetail shortlist={shortlist} initialCandidates={candidates} />
    </div>
  );
}
