/**
 * Server actions for candidate tags.
 *
 * Thin wrapper over `src/lib/tags/service`. Auth context is
 * constructed from the RLS-respecting server client; RLS is the
 * first line of defense, and the service enforces the
 * creator-or-admin rule on delete as a second line.
 */
'use server';

import { revalidatePath } from 'next/cache';

import { requireAuth } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { addTagToCandidate, removeTagFromCandidate } from '@/lib/tags/service';
import { TagError } from '@/lib/tags/errors';

export interface ActionResult {
  ok: boolean;
  error?: { code: string; message: string };
}

export async function addTagAction(candidateId: string, tagName: string): Promise<ActionResult> {
  const ctx = await requireAuth();
  const db = createClient();
  try {
    await addTagToCandidate(db, { authUserId: ctx.userId, role: ctx.role }, candidateId, tagName);
    revalidatePath(`/candidates/${candidateId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TagError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'unknown', message: String(e) } };
  }
}

export async function removeTagAction(candidateId: string, tagId: string): Promise<ActionResult> {
  const ctx = await requireAuth();
  const db = createClient();
  try {
    await removeTagFromCandidate(
      db,
      { authUserId: ctx.userId, role: ctx.role },
      candidateId,
      tagId,
    );
    revalidatePath(`/candidates/${candidateId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof TagError) {
      return { ok: false, error: { code: e.code, message: e.message } };
    }
    return { ok: false, error: { code: 'unknown', message: String(e) } };
  }
}
