/**
 * GET /api/shortlists/[id]/export.csv — CSV download of a shortlist.
 *
 * RLS scopes the shortlist to what the caller can see. A 404 here
 * means either the shortlist doesn't exist or isn't visible to this
 * user — the UI treats both the same. Response is `text/csv` with
 * `Content-Disposition: attachment` so the browser downloads it.
 */
import { NextResponse, type NextRequest } from 'next/server';

import { getAuthUser } from '@/lib/auth/require';
import { candidatesToCsv, getShortlist, listShortlistCandidates } from '@/lib/shortlists/service';
import { createClient } from '@/lib/supabase/server';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function sanitizeFilename(name: string): string {
  // Keep ASCII alphanumerics, dash, underscore. Everything else → `_`.
  const base = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 60);
  return base.length > 0 ? base : 'shortlist';
}

export async function GET(
  _request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const auth = await getAuthUser();
  if (!auth) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const supabase = createClient();
  const shortlist = await getShortlist(supabase, params.id);
  if (!shortlist) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  const rows = await listShortlistCandidates(supabase, shortlist.id);
  const csv = candidatesToCsv(rows);
  const filename = `${sanitizeFilename(shortlist.name)}.csv`;

  return new NextResponse(csv, {
    status: 200,
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Cache-Control': 'no-store',
    },
  });
}
