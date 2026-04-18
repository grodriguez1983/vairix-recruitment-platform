/**
 * Server actions for shortlist operations.
 *
 * Thin wrappers around `src/lib/shortlists/service`. RLS enforces
 * who can read/write; the service enforces lifecycle rules
 * (archive semantics, idempotency, NOT_FOUND).
 */
'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { requireAuth } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import {
  addCandidateToShortlist,
  archiveShortlist,
  createShortlist,
  removeCandidateFromShortlist,
} from '@/lib/shortlists/service';
import { ShortlistError } from '@/lib/shortlists/errors';

export interface ShortlistActionResult {
  ok: boolean;
  id?: string;
  error?: { code: string; message: string };
}

function wrapError(e: unknown): ShortlistActionResult {
  if (e instanceof ShortlistError) {
    return { ok: false, error: { code: e.code, message: e.message } };
  }
  return { ok: false, error: { code: 'unknown', message: String(e) } };
}

export async function createShortlistAction(
  name: string,
  description?: string | null,
): Promise<ShortlistActionResult> {
  const ctx = await requireAuth();
  const db = createClient();
  try {
    const sl = await createShortlist(
      db,
      { authUserId: ctx.userId, role: ctx.role },
      { name, description: description ?? null },
    );
    revalidatePath('/shortlists');
    return { ok: true, id: sl.id };
  } catch (e) {
    return wrapError(e);
  }
}

export async function createShortlistAndRedirect(formData: FormData): Promise<never> {
  const name = String(formData.get('name') ?? '').trim();
  const description = String(formData.get('description') ?? '').trim();
  const res = await createShortlistAction(name, description || null);
  if (!res.ok || !res.id) {
    // Redirect back with an error query param; minimalist error UX.
    redirect(`/shortlists?error=${encodeURIComponent(res.error?.message ?? 'unknown')}`);
  }
  redirect(`/shortlists/${res.id}`);
}

export async function addCandidateAction(
  shortlistId: string,
  candidateId: string,
  note?: string | null,
): Promise<ShortlistActionResult> {
  const ctx = await requireAuth();
  const db = createClient();
  try {
    await addCandidateToShortlist(
      db,
      { authUserId: ctx.userId, role: ctx.role },
      shortlistId,
      candidateId,
      note ?? null,
    );
    revalidatePath(`/shortlists/${shortlistId}`);
    revalidatePath(`/candidates/${candidateId}`);
    return { ok: true };
  } catch (e) {
    return wrapError(e);
  }
}

export async function removeCandidateAction(
  shortlistId: string,
  candidateId: string,
): Promise<ShortlistActionResult> {
  await requireAuth();
  const db = createClient();
  try {
    await removeCandidateFromShortlist(db, shortlistId, candidateId);
    revalidatePath(`/shortlists/${shortlistId}`);
    return { ok: true };
  } catch (e) {
    return wrapError(e);
  }
}

export async function archiveShortlistAction(shortlistId: string): Promise<ShortlistActionResult> {
  await requireAuth();
  const db = createClient();
  try {
    await archiveShortlist(db, shortlistId);
    revalidatePath('/shortlists');
    revalidatePath(`/shortlists/${shortlistId}`);
    return { ok: true };
  } catch (e) {
    return wrapError(e);
  }
}
