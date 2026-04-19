/**
 * Rejection normalizer orchestrator (ADR-007 §2).
 *
 * Runs after the evaluations sync. For every evaluation with a
 * non-null `rejection_reason` and a null `rejection_category_id`
 * (or any reason at all, when `force=true`), resolves the category
 * via `classifyRejectionReason` and writes:
 *
 *   - `rejection_category_id` → matching category UUID
 *   - `needs_review` → true iff fallback was used
 *   - `normalization_attempted_at` → now()
 *
 * Evaluations with null `rejection_reason` are left untouched
 * (no category to infer). Batch size is bounded; the service-role
 * client is required because we write across all tenants.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { classifyRejectionReason } from './classify';

export interface NormalizeOptions {
  /** Process all evaluations with a reason, including already-normalized ones. */
  force?: boolean;
  /** Upper bound on rows fetched in one run (default 500). */
  batchSize?: number;
  /**
   * When true, classify every candidate row but skip all writes. Used by
   * the operator CLI to preview the impact (count + samples) before
   * applying. Counts are still populated; `samples` is filled with up to
   * 10 representative classifications.
   */
  dryRun?: boolean;
}

export interface NormalizeResult {
  /** Rows that had a non-null reason and would be / were updated. */
  processed: number;
  /** Subset of `processed` where a keyword rule matched. */
  matched: number;
  /** Subset of `processed` that fell through to 'other' + needs_review. */
  unmatched: number;
  /**
   * Up to 10 (reason → category) samples. Populated on every run; in
   * dry-run mode it's the only signal the operator can act on.
   */
  samples: Array<{ id: string; reason: string; code: string; needsReview: boolean }>;
}

interface PendingRow {
  id: string;
  rejection_reason: string | null;
}

async function loadCategoryIds(db: SupabaseClient): Promise<Map<string, string>> {
  const { data, error } = await db.from('rejection_categories').select('id, code');
  if (error) throw new Error(`failed to load rejection_categories: ${error.message}`);
  const map = new Map<string, string>();
  for (const row of data ?? []) {
    map.set(row.code as string, row.id as string);
  }
  if (!map.has('other')) {
    throw new Error('rejection_categories is missing the seeded "other" row');
  }
  return map;
}

export async function normalizeRejections(
  db: SupabaseClient,
  options: NormalizeOptions = {},
): Promise<NormalizeResult> {
  const { force = false, batchSize = 500, dryRun = false } = options;
  const categories = await loadCategoryIds(db);

  let query = db
    .from('evaluations')
    .select('id, rejection_reason')
    .not('rejection_reason', 'is', null)
    .limit(batchSize);
  if (!force) {
    query = query.is('rejection_category_id', null);
  }
  const { data, error } = await query;
  if (error) throw new Error(`failed to read evaluations: ${error.message}`);

  const rows = (data ?? []) as PendingRow[];
  const now = new Date().toISOString();
  let matched = 0;
  let unmatched = 0;
  const samples: NormalizeResult['samples'] = [];

  for (const row of rows) {
    const result = classifyRejectionReason(row.rejection_reason);
    if (!result) continue;
    const categoryId = categories.get(result.code);
    if (!categoryId) {
      throw new Error(`classifier returned unknown category code: ${result.code}`);
    }
    if (!dryRun) {
      const { error: updateError } = await db
        .from('evaluations')
        .update({
          rejection_category_id: categoryId,
          needs_review: result.needsReview,
          normalization_attempted_at: now,
        })
        .eq('id', row.id);
      if (updateError) {
        throw new Error(`failed to update evaluation ${row.id}: ${updateError.message}`);
      }
    }
    if (samples.length < 10) {
      samples.push({
        id: row.id,
        reason: row.rejection_reason ?? '',
        code: result.code,
        needsReview: result.needsReview,
      });
    }
    if (result.needsReview) unmatched += 1;
    else matched += 1;
  }

  return { processed: matched + unmatched, matched, unmatched, samples };
}
