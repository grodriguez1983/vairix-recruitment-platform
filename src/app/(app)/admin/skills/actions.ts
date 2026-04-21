/**
 * Server actions for `/admin/skills` CRUD (ADR-013 §6).
 *
 * Admin-only. RLS on `skills` + `skill_aliases` restricts writes to
 * admins (migration 20260420000001); `requireRole('admin')` gives a
 * clean 403 instead of a silent RLS deny.
 */
'use server';

import { revalidatePath } from 'next/cache';

import { requireRole } from '@/lib/auth/require';
import {
  addAlias,
  removeAlias,
  setDeprecated,
  updateSkill,
  type UpdateSkillInput,
} from '@/lib/skills/admin-service';
import { createClient } from '@/lib/supabase/server';
import { UncatalogedAdminError } from '@/lib/skills/uncataloged-errors';

export interface ActionResult {
  ok: boolean;
  error?: { code: string; message: string };
}

function toError(e: unknown): ActionResult {
  if (e instanceof UncatalogedAdminError) {
    return { ok: false, error: { code: e.code, message: e.message } };
  }
  return { ok: false, error: { code: 'unknown', message: String(e) } };
}

function revalidateAll(id: string): void {
  revalidatePath('/admin/skills');
  revalidatePath(`/admin/skills/${id}`);
  revalidatePath('/admin');
}

export async function updateSkillAction(
  id: string,
  input: UpdateSkillInput,
): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await updateSkill(db, id, input);
    revalidateAll(id);
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function setDeprecatedAction(id: string, deprecated: boolean): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await setDeprecated(db, id, deprecated);
    revalidateAll(id);
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function addAliasAction(skillId: string, rawAlias: string): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await addAlias(db, skillId, rawAlias);
    revalidateAll(skillId);
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}

export async function removeAliasAction(skillId: string, aliasId: string): Promise<ActionResult> {
  await requireRole('admin');
  const db = createClient();
  try {
    await removeAlias(db, aliasId);
    revalidateAll(skillId);
    return { ok: true };
  } catch (e) {
    return toError(e);
  }
}
