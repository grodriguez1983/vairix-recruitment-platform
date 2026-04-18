/**
 * Server action to mark a sync_error as resolved.
 *
 * Admin-only: the RLS policy on `sync_errors` (see
 * 20260417205213_rls_sync_errors.sql) rejects non-admin writes.
 * We also explicitly `requireRole('admin')` so a recruiter hitting
 * the action URL gets a 403 redirect instead of a silent no-op.
 */
'use server';

import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { resolveSyncError } from '@/lib/sync-errors/service';
import { SyncErrorAdminError } from '@/lib/sync-errors/errors';

export interface ResolveActionResult {
  ok: boolean;
  error?: { code: string; message: string };
}

export async function resolveSyncErrorAction(id: string): Promise<ResolveActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await resolveSyncError(db, id);
    revalidatePath('/admin/sync-errors');
    return { ok: true };
  } catch (e) {
    if (e instanceof SyncErrorAdminError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'unknown', message: String(e) } };
  }
}
