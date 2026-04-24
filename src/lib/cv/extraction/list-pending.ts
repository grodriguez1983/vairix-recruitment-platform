/**
 * `listPendingExtractions` — returns `files` rows that still need a
 * `candidate_extractions` row for the current `(model, prompt_version)`.
 *
 * Context / why this exists (ADR-012 §6, follow-up to Bloque 16):
 *
 * The CLI (`src/scripts/extract-cvs.ts`) and the integration test used
 * to build the query inline with a `.not('id', 'in', `(${excluded})`)`
 * clause. Once the set of already-extracted files grew past ~300, the
 * joined URL crossed PostgREST's ~16 KB budget and every invocation
 * errored with `URI too long`.
 *
 * The fix hoists the query here and moves the exclusion filter into
 * memory: fetch the parsed files (ordered, capped to
 * `limit + excluded.size`) and drop excluded ids client-side. This
 * mirrors the same approach used by the embeddings workers after the
 * Bloque 16 regression; the two helpers are intentionally *not*
 * unified because they have different keys and different exhaustion
 * semantics.
 *
 * Invariants (tested):
 *   - never passes the excluded list inline to the URL, regardless of
 *     its size;
 *   - returns at most `limit` rows;
 *   - preserves `created_at ASC` ordering coming from Postgres;
 *   - strips excluded ids correctly even when Postgres returns more
 *     than `limit` candidates;
 *   - empty pending → empty result;
 *   - surfaces Supabase errors instead of swallowing them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

export interface ListPendingExtractionsInput {
  model: string;
  promptVersion: string;
  limit: number;
}

export interface PendingExtractionRow {
  file_id: string;
  candidate_id: string;
  parsed_text: string;
}

export async function listPendingExtractions(
  _db: SupabaseClient,
  _input: ListPendingExtractionsInput,
): Promise<PendingExtractionRow[]> {
  throw new Error('listPendingExtractions not implemented');
}
