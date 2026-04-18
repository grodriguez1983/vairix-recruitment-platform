/**
 * POST /api/candidates/[id]/vairix-sheet — manual upload of the
 * VAIRIX-normalized CV sheet for a candidate.
 *
 * Auth: admin only (recruiters can read via the profile page but
 *   cannot write files — matches the RLS matrix on `files`).
 *
 * Storage: writes to the private `candidate-cvs` bucket at
 *   `<candidate_uuid>/<file_uuid>.<ext>`. Uses the user's JWT —
 *   the bucket's storage.objects policy grants admin ALL access.
 *
 * DB: enforces "one active vairix_cv_sheet per candidate" by
 *   soft-deleting the previous sheet (`deleted_at = now()`) before
 *   inserting the new row. The partial unique index on
 *   (candidate_id) where kind='vairix_cv_sheet' and deleted_at is
 *   null gates this at the schema level (see
 *   20260418230000_files_kind.sql).
 *
 * Response:
 *   200 { ok: true, storagePath, fileName, kind: 'vairix_cv_sheet' }
 *   400 { error: 'invalid_id' | 'no_file' | 'empty_file' |
 *                 'file_too_large' | 'unsupported_extension' }
 *   401 { error: 'unauthenticated' }
 *   403 { error: 'forbidden' }
 *   404 { error: 'candidate_not_found' }
 *   500 { error: 'storage_failed' | 'db_failed' }
 */
import { createHash, randomUUID } from 'node:crypto';
import { NextResponse, type NextRequest } from 'next/server';

import { getAuthUser } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { BUCKET } from '@/lib/cv/downloader';
import { validateVairixSheet } from '@/lib/cv/vairix-sheet';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function POST(
  request: NextRequest,
  { params }: { params: { id: string } },
): Promise<NextResponse> {
  const auth = await getAuthUser();
  if (!auth) {
    return NextResponse.json({ error: 'unauthenticated' }, { status: 401 });
  }
  if (auth.role !== 'admin') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 });
  }
  if (!UUID_REGEX.test(params.id)) {
    return NextResponse.json({ error: 'invalid_id' }, { status: 400 });
  }

  const supabase = createClient();
  const { data: candidate, error: candErr } = await supabase
    .from('candidates')
    .select('id')
    .eq('id', params.id)
    .maybeSingle();
  if (candErr || !candidate) {
    return NextResponse.json({ error: 'candidate_not_found' }, { status: 404 });
  }

  const form = await request.formData();
  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no_file' }, { status: 400 });
  }
  const v = validateVairixSheet({ fileName: file.name, sizeBytes: file.size });
  if (!v.ok) {
    return NextResponse.json({ error: v.code }, { status: 400 });
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  const contentHash = createHash('sha256').update(bytes).digest('hex');
  const fileUuid = randomUUID();
  const storagePath = `${params.id}/${fileUuid}.${v.ext}`;

  // Upload first; if it fails we don't touch the DB.
  const { error: upErr } = await supabase.storage
    .from(BUCKET)
    .upload(storagePath, bytes, { contentType: file.type || undefined, upsert: false });
  if (upErr) {
    return NextResponse.json({ error: 'storage_failed', detail: upErr.message }, { status: 500 });
  }

  // Soft-delete any previous active sheet so the partial unique
  // index stays satisfied. Only then insert the new row.
  const nowIso = new Date().toISOString();
  const { error: delErr } = await supabase
    .from('files')
    .update({ deleted_at: nowIso })
    .eq('candidate_id', params.id)
    .eq('kind', 'vairix_cv_sheet')
    .is('deleted_at', null);
  if (delErr) {
    return NextResponse.json(
      { error: 'db_failed', detail: `soft-delete: ${delErr.message}` },
      { status: 500 },
    );
  }

  const { error: insErr } = await supabase.from('files').insert({
    candidate_id: params.id,
    storage_path: storagePath,
    file_type: v.ext,
    file_size_bytes: v.sizeBytes,
    content_hash: contentHash,
    is_internal: true,
    kind: 'vairix_cv_sheet',
    raw_data: { source: 'manual_upload', originalFileName: file.name, uploadedAt: nowIso },
  });
  if (insErr) {
    return NextResponse.json(
      { error: 'db_failed', detail: `insert: ${insErr.message}` },
      { status: 500 },
    );
  }

  return NextResponse.json({
    ok: true,
    storagePath,
    fileName: file.name,
    kind: 'vairix_cv_sheet',
  });
}
