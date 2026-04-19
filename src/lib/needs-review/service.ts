/**
 * Admin service for evaluations flagged `needs_review=true` (F2-004).
 *
 * After the rejection normalizer (ADR-007 §2) falls back to the
 * `other` category, it sets `needs_review=true`. Admins use this
 * surface to either reclassify the row into a concrete category or
 * dismiss it (`other` is genuinely correct).
 *
 * All writes gated by `evaluations` RLS (admin R/W). Service-role
 * bypasses RLS in tests; admins in-app hit the same code path with
 * their JWT so RLS enforces the role.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { NeedsReviewAdminError } from './errors';

export interface NeedsReviewRow {
  id: string;
  candidate_id: string;
  decision: string | null;
  rejection_reason: string | null;
  rejection_category_id: string | null;
  normalization_attempted_at: string | null;
  created_at: string;
  candidate_first_name: string | null;
  candidate_last_name: string | null;
}

export interface RejectionCategoryRow {
  id: string;
  code: string;
  display_name: string;
  sort_order: number | null;
}

export interface ListNeedsReviewOptions {
  limit?: number;
  offset?: number;
}

const SELECT =
  'id, candidate_id, decision, rejection_reason, rejection_category_id, normalization_attempted_at, created_at, candidates(first_name, last_name)';

interface RawRow {
  id: string;
  candidate_id: string;
  decision: string | null;
  rejection_reason: string | null;
  rejection_category_id: string | null;
  normalization_attempted_at: string | null;
  created_at: string;
  candidates: { first_name: string | null; last_name: string | null } | null;
}

function flatten(row: RawRow): NeedsReviewRow {
  return {
    id: row.id,
    candidate_id: row.candidate_id,
    decision: row.decision,
    rejection_reason: row.rejection_reason,
    rejection_category_id: row.rejection_category_id,
    normalization_attempted_at: row.normalization_attempted_at,
    created_at: row.created_at,
    candidate_first_name: row.candidates?.first_name ?? null,
    candidate_last_name: row.candidates?.last_name ?? null,
  };
}

export async function listNeedsReview(
  db: SupabaseClient,
  options: ListNeedsReviewOptions = {},
): Promise<NeedsReviewRow[]> {
  const { limit = 50, offset = 0 } = options;
  const { data, error } = await db
    .from('evaluations')
    .select(SELECT)
    .eq('needs_review', true)
    .is('deleted_at', null)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) {
    throw new NeedsReviewAdminError('failed to list needs_review', 'db_error', {
      cause: error.message,
    });
  }
  return ((data ?? []) as unknown as RawRow[]).map(flatten);
}

export async function countNeedsReview(db: SupabaseClient): Promise<number> {
  const { count, error } = await db
    .from('evaluations')
    .select('id', { count: 'exact', head: true })
    .eq('needs_review', true)
    .is('deleted_at', null);
  if (error) {
    throw new NeedsReviewAdminError('failed to count needs_review', 'db_error', {
      cause: error.message,
    });
  }
  return count ?? 0;
}

export async function listRejectionCategories(db: SupabaseClient): Promise<RejectionCategoryRow[]> {
  const { data, error } = await db
    .from('rejection_categories')
    .select('id, code, display_name, sort_order')
    .is('deprecated_at', null)
    .order('sort_order', { ascending: true });
  if (error) {
    throw new NeedsReviewAdminError('failed to list categories', 'db_error', {
      cause: error.message,
    });
  }
  return (data ?? []) as RejectionCategoryRow[];
}

/**
 * Reassign an evaluation to a concrete category and clear
 * `needs_review`. Use when the admin confirms the correct bucket.
 */
export async function reclassifyAndClear(
  db: SupabaseClient,
  evaluationId: string,
  categoryId: string,
): Promise<void> {
  // Verify the category exists and isn't deprecated.
  const { data: cat, error: catErr } = await db
    .from('rejection_categories')
    .select('id, deprecated_at')
    .eq('id', categoryId)
    .maybeSingle();
  if (catErr) {
    throw new NeedsReviewAdminError('failed to read category', 'db_error', {
      cause: catErr.message,
    });
  }
  if (!cat) {
    throw new NeedsReviewAdminError('category not found', 'invalid_category', {
      categoryId,
    });
  }
  if (cat.deprecated_at) {
    throw new NeedsReviewAdminError('category is deprecated', 'invalid_category', {
      categoryId,
    });
  }

  const { data: existing, error: readErr } = await db
    .from('evaluations')
    .select('id, needs_review')
    .eq('id', evaluationId)
    .maybeSingle();
  if (readErr) {
    throw new NeedsReviewAdminError('failed to read evaluation', 'db_error', {
      cause: readErr.message,
    });
  }
  if (!existing) {
    throw new NeedsReviewAdminError('evaluation not found', 'not_found', {
      evaluationId,
    });
  }
  if (!existing.needs_review) {
    throw new NeedsReviewAdminError('evaluation already cleared', 'already_cleared', {
      evaluationId,
    });
  }

  const { error } = await db
    .from('evaluations')
    .update({
      rejection_category_id: categoryId,
      needs_review: false,
    })
    .eq('id', evaluationId);
  if (error) {
    throw new NeedsReviewAdminError('failed to reclassify', 'db_error', {
      cause: error.message,
    });
  }
}

/**
 * Accept the current (`other`) classification and clear the flag —
 * useful when the rejection reason genuinely doesn't fit any rule.
 */
export async function dismissAndClear(db: SupabaseClient, evaluationId: string): Promise<void> {
  const { data: existing, error: readErr } = await db
    .from('evaluations')
    .select('id, needs_review')
    .eq('id', evaluationId)
    .maybeSingle();
  if (readErr) {
    throw new NeedsReviewAdminError('failed to read evaluation', 'db_error', {
      cause: readErr.message,
    });
  }
  if (!existing) {
    throw new NeedsReviewAdminError('evaluation not found', 'not_found', {
      evaluationId,
    });
  }
  if (!existing.needs_review) {
    throw new NeedsReviewAdminError('evaluation already cleared', 'already_cleared', {
      evaluationId,
    });
  }

  const { error } = await db
    .from('evaluations')
    .update({ needs_review: false })
    .eq('id', evaluationId);
  if (error) {
    throw new NeedsReviewAdminError('failed to dismiss', 'db_error', {
      cause: error.message,
    });
  }
}
