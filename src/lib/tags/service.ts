/**
 * Tag service — pure business logic, decoupled from Next.js.
 *
 * Takes an injectable Supabase client + auth context so it's
 * testable against a service-role client (bypassing RLS in tests).
 * The Next.js server action layer is a thin wrapper that constructs
 * the RLS-respecting client from cookies.
 *
 * Rules enforced here:
 *   1. Tag `name` is trimmed and normalized (lowercase) before
 *      uniqueness lookup; rejects empty strings.
 *   2. Adding a tag is "upsert-like": if a tag with the same
 *      normalized name exists, reuse it.
 *   3. Deleting a candidate_tag requires the caller to be the
 *      creator OR have role='admin'. Other authenticated users
 *      get 'forbidden'.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { TagError } from './errors';

export interface TagCtx {
  /** auth.users.id of the current user. */
  authUserId: string;
  /** app_users role of the current user. */
  role: 'recruiter' | 'admin';
}

export interface TagRow {
  id: string;
  name: string;
  category: string | null;
}

export interface CandidateTagRow {
  candidate_id: string;
  tag_id: string;
  created_by: string | null;
  source: string;
}

/** Trim + lowercase for dedup; reject empty after trim. */
export function normalizeTagName(raw: string): string {
  const v = raw.trim().toLowerCase();
  if (v.length === 0) throw new TagError('tag name is empty', 'invalid_name');
  if (v.length > 64)
    throw new TagError('tag name too long (max 64 chars)', 'invalid_name', { length: v.length });
  return v;
}

async function resolveAppUserId(db: SupabaseClient, authUserId: string): Promise<string> {
  const { data, error } = await db
    .from('app_users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .is('deactivated_at', null)
    .maybeSingle();
  if (error) {
    throw new TagError('failed to resolve app_user', 'db_error', { cause: error.message });
  }
  if (!data) {
    throw new TagError('no active app_users row', 'app_user_not_found', { authUserId });
  }
  return data.id as string;
}

/**
 * Ensures a tag with `name` exists and returns its id. Uses
 * `upsert` with `onConflict: 'name'` so concurrent creates collapse
 * safely.
 */
export async function ensureTag(db: SupabaseClient, rawName: string): Promise<TagRow> {
  const name = normalizeTagName(rawName);
  // Try fetch first (common case: tag already exists).
  const { data: existing, error: selectError } = await db
    .from('tags')
    .select('id, name, category')
    .eq('name', name)
    .maybeSingle();
  if (selectError)
    throw new TagError('tag lookup failed', 'db_error', { cause: selectError.message });
  if (existing) return existing as TagRow;

  const { data: inserted, error: insertError } = await db
    .from('tags')
    .insert({ name })
    .select('id, name, category')
    .single();
  if (insertError) {
    // Race: someone else created it between our select and insert.
    // Fetch again and return.
    const { data: raced } = await db
      .from('tags')
      .select('id, name, category')
      .eq('name', name)
      .maybeSingle();
    if (raced) return raced as TagRow;
    throw new TagError('tag insert failed', 'db_error', { cause: insertError.message });
  }
  return inserted as TagRow;
}

/**
 * Links a tag to a candidate. Idempotent: if the link already exists
 * it's left as-is (no error), so the UI can call this unconditionally.
 *
 * Returns the created/existing link row.
 */
export async function addTagToCandidate(
  db: SupabaseClient,
  ctx: TagCtx,
  candidateId: string,
  rawName: string,
): Promise<{ tag: TagRow; created: boolean }> {
  const appUserId = await resolveAppUserId(db, ctx.authUserId);
  const tag = await ensureTag(db, rawName);

  const { data: existing } = await db
    .from('candidate_tags')
    .select('candidate_id')
    .eq('candidate_id', candidateId)
    .eq('tag_id', tag.id)
    .maybeSingle();
  if (existing) return { tag, created: false };

  const { error: linkError } = await db.from('candidate_tags').insert({
    candidate_id: candidateId,
    tag_id: tag.id,
    source: 'manual',
    created_by: appUserId,
  });
  if (linkError) {
    throw new TagError('candidate_tag insert failed', 'db_error', { cause: linkError.message });
  }
  return { tag, created: true };
}

/**
 * Removes a tag from a candidate. Authorization: caller must be the
 * `created_by` app_user OR have role='admin'.
 */
export async function removeTagFromCandidate(
  db: SupabaseClient,
  ctx: TagCtx,
  candidateId: string,
  tagId: string,
): Promise<void> {
  const appUserId = await resolveAppUserId(db, ctx.authUserId);

  const { data: link, error: lookupError } = await db
    .from('candidate_tags')
    .select('candidate_id, tag_id, created_by')
    .eq('candidate_id', candidateId)
    .eq('tag_id', tagId)
    .maybeSingle();
  if (lookupError)
    throw new TagError('candidate_tag lookup failed', 'db_error', { cause: lookupError.message });
  if (!link) throw new TagError('candidate_tag not found', 'not_found', { candidateId, tagId });

  const isCreator = link.created_by === appUserId;
  const isAdmin = ctx.role === 'admin';
  if (!isCreator && !isAdmin) {
    throw new TagError('only the creator or an admin can remove this tag', 'forbidden', {
      candidateId,
      tagId,
      callerRole: ctx.role,
    });
  }

  const { error: delError } = await db
    .from('candidate_tags')
    .delete()
    .eq('candidate_id', candidateId)
    .eq('tag_id', tagId);
  if (delError)
    throw new TagError('candidate_tag delete failed', 'db_error', { cause: delError.message });
}

export async function listTagsForCandidate(
  db: SupabaseClient,
  candidateId: string,
): Promise<Array<TagRow & { created_by: string | null }>> {
  const { data, error } = await db
    .from('candidate_tags')
    .select('created_by, tags(id, name, category)')
    .eq('candidate_id', candidateId);
  if (error) throw new TagError('list tags failed', 'db_error', { cause: error.message });
  return (data ?? [])
    .filter((r) => r.tags !== null)
    .map((r) => ({
      id: (r.tags as unknown as TagRow).id,
      name: (r.tags as unknown as TagRow).name,
      category: (r.tags as unknown as TagRow).category,
      created_by: r.created_by as string | null,
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function listAllTagNames(db: SupabaseClient): Promise<string[]> {
  const { data, error } = await db.from('tags').select('name').order('name');
  if (error) throw new TagError('list all tags failed', 'db_error', { cause: error.message });
  return (data ?? []).map((r) => r.name as string);
}
