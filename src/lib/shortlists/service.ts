/**
 * Shortlist service — business logic for UC-03.
 *
 * A shortlist is a named collection of candidates, optionally
 * scoped to a job, owned by an app_user. Shortlists can be
 * archived (soft-hidden) but not deleted (restrictive FK on
 * `created_by`).
 *
 * Rules enforced here:
 *   1. Name is trimmed, non-empty, ≤ 120 chars.
 *   2. `addCandidate` is idempotent: adding a candidate twice is a
 *      no-op (returns { created: false }).
 *   3. Archiving an already-archived shortlist throws.
 *   4. Modifications on an archived shortlist throw — UI must
 *      unarchive first (out of scope for F1-013; documented for F2).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { ShortlistError } from './errors';

export interface ShortlistCtx {
  authUserId: string;
  role: 'recruiter' | 'admin';
}

export interface Shortlist {
  id: string;
  name: string;
  description: string | null;
  job_id: string | null;
  created_by: string;
  archived_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ShortlistCandidate {
  shortlist_id: string;
  candidate_id: string;
  note: string | null;
  added_at: string;
  added_by: string;
}

export function normalizeShortlistName(raw: string): string {
  const v = raw.trim();
  if (v.length === 0) throw new ShortlistError('shortlist name is empty', 'invalid_name');
  if (v.length > 120)
    throw new ShortlistError('shortlist name too long (max 120 chars)', 'invalid_name', {
      length: v.length,
    });
  return v;
}

async function resolveAppUserId(db: SupabaseClient, authUserId: string): Promise<string> {
  const { data, error } = await db
    .from('app_users')
    .select('id')
    .eq('auth_user_id', authUserId)
    .is('deactivated_at', null)
    .maybeSingle();
  if (error)
    throw new ShortlistError('failed to resolve app_user', 'db_error', { cause: error.message });
  if (!data)
    throw new ShortlistError('no active app_users row', 'app_user_not_found', { authUserId });
  return data.id as string;
}

export async function createShortlist(
  db: SupabaseClient,
  ctx: ShortlistCtx,
  input: { name: string; description?: string | null; jobId?: string | null },
): Promise<Shortlist> {
  const name = normalizeShortlistName(input.name);
  const createdBy = await resolveAppUserId(db, ctx.authUserId);

  const { data, error } = await db
    .from('shortlists')
    .insert({
      name,
      description: input.description ?? null,
      job_id: input.jobId ?? null,
      created_by: createdBy,
    })
    .select('id, name, description, job_id, created_by, archived_at, created_at, updated_at')
    .single();
  if (error) throw new ShortlistError('create failed', 'db_error', { cause: error.message });
  return data as Shortlist;
}

export async function listActiveShortlists(
  db: SupabaseClient,
): Promise<Array<Shortlist & { candidate_count: number }>> {
  const { data, error } = await db
    .from('shortlists')
    .select(
      'id, name, description, job_id, created_by, archived_at, created_at, updated_at, shortlist_candidates(count)',
    )
    .is('archived_at', null)
    .order('updated_at', { ascending: false });
  if (error) throw new ShortlistError('list failed', 'db_error', { cause: error.message });
  return (data ?? []).map((r) => ({
    id: r.id as string,
    name: r.name as string,
    description: r.description as string | null,
    job_id: r.job_id as string | null,
    created_by: r.created_by as string,
    archived_at: r.archived_at as string | null,
    created_at: r.created_at as string,
    updated_at: r.updated_at as string,
    candidate_count:
      Array.isArray(r.shortlist_candidates) && r.shortlist_candidates.length > 0
        ? ((r.shortlist_candidates[0] as { count: number }).count ?? 0)
        : 0,
  }));
}

export async function getShortlist(
  db: SupabaseClient,
  shortlistId: string,
): Promise<Shortlist | null> {
  const { data, error } = await db
    .from('shortlists')
    .select('id, name, description, job_id, created_by, archived_at, created_at, updated_at')
    .eq('id', shortlistId)
    .maybeSingle();
  if (error) throw new ShortlistError('get failed', 'db_error', { cause: error.message });
  return (data as Shortlist) ?? null;
}

export async function addCandidateToShortlist(
  db: SupabaseClient,
  ctx: ShortlistCtx,
  shortlistId: string,
  candidateId: string,
  note?: string | null,
): Promise<{ created: boolean }> {
  const addedBy = await resolveAppUserId(db, ctx.authUserId);

  const shortlist = await getShortlist(db, shortlistId);
  if (!shortlist) throw new ShortlistError('shortlist not found', 'not_found', { shortlistId });
  if (shortlist.archived_at) {
    throw new ShortlistError('shortlist is archived', 'already_archived', { shortlistId });
  }

  const { data: existing } = await db
    .from('shortlist_candidates')
    .select('shortlist_id')
    .eq('shortlist_id', shortlistId)
    .eq('candidate_id', candidateId)
    .maybeSingle();
  if (existing) return { created: false };

  const { error } = await db.from('shortlist_candidates').insert({
    shortlist_id: shortlistId,
    candidate_id: candidateId,
    added_by: addedBy,
    note: note ?? null,
  });
  if (error) throw new ShortlistError('add candidate failed', 'db_error', { cause: error.message });
  return { created: true };
}

export async function removeCandidateFromShortlist(
  db: SupabaseClient,
  shortlistId: string,
  candidateId: string,
): Promise<void> {
  const { data: existing } = await db
    .from('shortlist_candidates')
    .select('shortlist_id')
    .eq('shortlist_id', shortlistId)
    .eq('candidate_id', candidateId)
    .maybeSingle();
  if (!existing) {
    throw new ShortlistError('candidate is not in this shortlist', 'not_in_shortlist', {
      shortlistId,
      candidateId,
    });
  }
  const { error } = await db
    .from('shortlist_candidates')
    .delete()
    .eq('shortlist_id', shortlistId)
    .eq('candidate_id', candidateId);
  if (error)
    throw new ShortlistError('remove candidate failed', 'db_error', { cause: error.message });
}

export async function archiveShortlist(db: SupabaseClient, shortlistId: string): Promise<void> {
  const shortlist = await getShortlist(db, shortlistId);
  if (!shortlist) throw new ShortlistError('shortlist not found', 'not_found', { shortlistId });
  if (shortlist.archived_at) {
    throw new ShortlistError('already archived', 'already_archived', { shortlistId });
  }
  const { error } = await db
    .from('shortlists')
    .update({ archived_at: new Date().toISOString() })
    .eq('id', shortlistId);
  if (error) throw new ShortlistError('archive failed', 'db_error', { cause: error.message });
}

export interface ShortlistCandidateRow {
  candidate_id: string;
  note: string | null;
  added_at: string;
  first_name: string | null;
  last_name: string | null;
  email: string | null;
}

export async function listShortlistCandidates(
  db: SupabaseClient,
  shortlistId: string,
): Promise<ShortlistCandidateRow[]> {
  const { data, error } = await db
    .from('shortlist_candidates')
    .select('candidate_id, note, added_at, candidates(first_name, last_name, email)')
    .eq('shortlist_id', shortlistId)
    .order('added_at', { ascending: false });
  if (error)
    throw new ShortlistError('list candidates failed', 'db_error', { cause: error.message });
  return (data ?? []).map((r) => {
    const cand = r.candidates as unknown as {
      first_name: string | null;
      last_name: string | null;
      email: string | null;
    } | null;
    return {
      candidate_id: r.candidate_id as string,
      note: r.note as string | null,
      added_at: r.added_at as string,
      first_name: cand?.first_name ?? null,
      last_name: cand?.last_name ?? null,
      email: cand?.email ?? null,
    };
  });
}

/**
 * Formats shortlist candidates as a CSV string (UTF-8, no BOM).
 * Escapes fields containing commas or quotes per RFC 4180.
 */
export function candidatesToCsv(rows: ShortlistCandidateRow[]): string {
  const header = ['candidate_id', 'first_name', 'last_name', 'email', 'note', 'added_at'];
  const escape = (v: string | null): string => {
    if (v === null) return '';
    if (/[",\n]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
    return v;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.candidate_id,
        r.first_name ?? '',
        r.last_name ?? '',
        r.email ?? '',
        r.note ?? '',
        r.added_at,
      ]
        .map((v) => escape(v))
        .join(','),
    );
  }
  return lines.join('\n') + '\n';
}
