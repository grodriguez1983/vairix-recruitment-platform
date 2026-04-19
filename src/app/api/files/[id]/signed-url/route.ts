/**
 * GET /api/files/[id]/signed-url — issues a short-lived signed URL
 * for a CV / VAIRIX sheet stored in the private `candidate-cvs`
 * bucket.
 *
 * Auth: any authenticated app user (recruiter or admin). RLS on
 *   `files` already enforces the read matrix — if maybeSingle()
 *   returns null we treat it as 404 regardless of the underlying
 *   cause (no such file OR RLS hid it; both are "not visible").
 *
 * TTL: 1 hour. Long enough for an iframe session + a manual
 *   download, short enough that a leaked URL becomes useless fast.
 *
 * Response:
 *   200 { url, expiresAt, fileName, kind }
 *   400 { error: 'invalid_id' }
 *   401 { error: 'unauthenticated' }
 *   404 { error: 'not_found' }
 *   410 { error: 'deleted' }          ← soft-deleted file
 *   500 { error: 'sign_failed' }
 */
import { NextResponse, type NextRequest } from 'next/server';

import { getAuthUser } from '@/lib/auth/require';
import { BUCKET } from '@/lib/cv/downloader';
import { createClient } from '@/lib/supabase/server';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const SIGNED_URL_TTL_SECONDS = 60 * 60;

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
  const { data: file } = await supabase
    .from('files')
    .select('storage_path, raw_data, kind, deleted_at')
    .eq('id', params.id)
    .maybeSingle();
  if (!file) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }
  if (file.deleted_at !== null) {
    return NextResponse.json({ error: 'deleted' }, { status: 410 });
  }

  const { data, error } = await supabase.storage
    .from(BUCKET)
    .createSignedUrl(file.storage_path as string, SIGNED_URL_TTL_SECONDS);
  if (error || !data) {
    return NextResponse.json(
      { error: 'sign_failed', detail: error?.message ?? 'no url returned' },
      { status: 500 },
    );
  }

  const expiresAt = new Date(Date.now() + SIGNED_URL_TTL_SECONDS * 1000).toISOString();

  // `raw_data.originalFileName` is set by the manual upload endpoint;
  // TT-synced rows keep the original file name in raw_data.attributes.fileName.
  const raw = (file.raw_data ?? {}) as Record<string, unknown>;
  const rawAttrs = ((raw['attributes'] as Record<string, unknown> | undefined) ?? {}) as Record<
    string,
    unknown
  >;
  const fileName =
    (raw['originalFileName'] as string | undefined) ??
    (rawAttrs['fileName'] as string | undefined) ??
    (file.storage_path as string).split('/').pop() ??
    null;

  return NextResponse.json({
    url: data.signedUrl,
    expiresAt,
    fileName,
    kind: file.kind,
  });
}
