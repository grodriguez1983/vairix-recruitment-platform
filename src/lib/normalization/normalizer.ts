/**
 * Rejection normalizer orchestrator — stub.
 *
 * Real implementation lands in the [GREEN] commit.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface NormalizeOptions {
  force?: boolean;
  batchSize?: number;
}

export interface NormalizeResult {
  processed: number;
  matched: number;
  unmatched: number;
}

export async function normalizeRejections(
  _db: SupabaseClient,
  _options: NormalizeOptions = {},
): Promise<NormalizeResult> {
  throw new Error('not implemented');
}
