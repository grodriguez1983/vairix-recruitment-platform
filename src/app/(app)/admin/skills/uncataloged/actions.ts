/**
 * Server actions for `/admin/skills/uncataloged` (ADR-013 §5).
 *
 * Admin-only. RLS on `skills` + `skill_aliases` + `skills_blacklist`
 * already restricts writes to admins (migration 20260420000001);
 * `requireRole('admin')` short-circuits with a 403 instead of a
 * silent no-op when a recruiter hits the action URL directly.
 */
'use server';

import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';
import { addSkillToCatalog, blacklistAlias, type AddSkillResult } from '@/lib/skills/uncataloged';
import { UncatalogedAdminError } from '@/lib/skills/uncataloged-errors';

export interface ActionResult<T = undefined> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string };
}

function toError<T>(e: unknown): ActionResult<T> {
  if (e instanceof UncatalogedAdminError) {
    return { ok: false, error: { code: e.code, message: e.message } };
  }
  return { ok: false, error: { code: 'unknown', message: String(e) } };
}

export interface AddToCatalogInput {
  canonical_name: string;
  slug: string;
  category: string | null;
  extra_aliases: string[];
}

export async function addToCatalogAction(
  input: AddToCatalogInput,
): Promise<ActionResult<AddSkillResult>> {
  await requireRole('admin');
  const db = createClient();
  try {
    const result = await addSkillToCatalog(db, input);
    revalidatePath('/admin/skills/uncataloged');
    revalidatePath('/admin');
    return { ok: true, data: result };
  } catch (e) {
    return toError(e);
  }
}

export async function blacklistAction(aliasNormalized: string): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await blacklistAlias(db, { alias_normalized: aliasNormalized });
    revalidatePath('/admin/skills/uncataloged');
    revalidatePath('/admin');
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}
