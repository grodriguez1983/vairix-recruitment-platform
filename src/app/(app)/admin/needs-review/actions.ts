/**
 * Server actions for the needs-review admin panel (F2-004).
 *
 * Admin-only. RLS on `evaluations` restricts writes to role=admin but
 * we also call `requireRole('admin')` so a recruiter hitting the action
 * URL gets 403 instead of a silent no-op.
 */
'use server';

import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { NeedsReviewAdminError } from '@/lib/needs-review/errors';
import { dismissAndClear, reclassifyAndClear } from '@/lib/needs-review/service';

export interface ActionResult {
  ok: boolean;
  error?: { code: string; message: string };
}

function toResult(e: unknown): ActionResult {
  if (e instanceof NeedsReviewAdminError) {
    return { ok: false, error: { code: e.code, message: e.message } };
  }
  return { ok: false, error: { code: 'unknown', message: String(e) } };
}

export async function reclassifyAction(
  evaluationId: string,
  categoryId: string,
): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await reclassifyAndClear(db, evaluationId, categoryId);
    revalidatePath('/admin/needs-review');
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}

export async function dismissAction(evaluationId: string): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await dismissAndClear(db, evaluationId);
    revalidatePath('/admin/needs-review');
    return { ok: true };
  } catch (e) {
    return toResult(e);
  }
}
