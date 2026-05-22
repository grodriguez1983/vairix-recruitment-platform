/**
 * `listPendingExtractions` — returns `files` rows that still need a
 * `candidate_extractions` row for the current `(model, prompt_version)`.
 *
 * Context / why this exists (ADR-012 §6, follow-up to Bloque 16, fixed
 * for ADR-029):
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
 * **ADR-029 amendment**: dedupe is now by `expectedHash`, not by
 * `file_id`. The schema's UNIQUE on `content_hash` already implies
 * "an extraction is current iff its hash matches the file's parsed_text
 * under (model, prompt_version)". Querying just `file_id` was strictly
 * weaker than the schema and caused stale extractions to block re-extract
 * after a CV update in TT.
 *
 * Invariants (tested):
 *   - never passes the excluded list inline to the URL, regardless of
 *     its size;
 *   - returns at most `limit` rows;
 *   - preserves `created_at ASC` ordering coming from Postgres;
 *   - strips files whose current parsed_text already has an extraction
 *     (hash match), keeps files whose parsed_text changed (hash miss);
 *   - empty pending → empty result;
 *   - surfaces Supabase errors instead of swallowing them.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { extractionContentHash } from './hash';

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
  db: SupabaseClient,
  input: ListPendingExtractionsInput,
): Promise<PendingExtractionRow[]> {
  const { model, promptVersion, limit } = input;

  // ADR-029: read content_hash (not just file_id) so we can compare
  // against the hash the file would produce given its CURRENT
  // parsed_text. A file_id whose row's content_hash differs from the
  // expected one is a stale extraction → file is pending re-extract.
  //
  // Paginated for the same reason as the files query below: once
  // candidate_extractions grows past PostgREST's max_rows cap, an
  // un-paginated SELECT silently truncates and the helper starts
  // missing exclusions (files re-appear as pending → duplicate work
  // and waste against the UNIQUE constraint).
  const existingHashes = new Set<string>();
  let existingFrom = 0;
  for (;;) {
    const { data: existing, error: existingErr } = await db
      .from('candidate_extractions')
      .select('content_hash')
      .eq('model', model)
      .eq('prompt_version', promptVersion)
      .range(existingFrom, existingFrom + FILES_PAGE_SIZE - 1);
    if (existingErr) throw new Error(existingErr.message);
    const page = existing ?? [];
    if (page.length === 0) break;
    for (const row of page) {
      const hash = (row as { content_hash: string | null }).content_hash;
      if (typeof hash === 'string' && hash.length > 0) existingHashes.add(hash);
    }
    existingFrom += page.length;
  }

  // Paginate the files query. PostgREST caps any single request at
  // `max_rows` (1000 by default), so the old `.limit(limit + existing)`
  // strategy silently returned [] once `existing.size >= max_rows` —
  // the request never saw past the already-extracted prefix. We walk
  // pages of FILES_PAGE_SIZE rows and accumulate pending in memory
  // until we have `limit` or the table is exhausted.
  const out: PendingExtractionRow[] = [];
  let from = 0;
  for (;;) {
    const { data: files, error: filesErr } = await db
      .from('files')
      .select('id, candidate_id, parsed_text')
      .is('deleted_at', null)
      .not('parsed_text', 'is', null)
      .is('parse_error', null)
      // ORDER BY (created_at, id): the ETL upserts files in batches
      // that share `created_at` down to the microsecond (observed
      // 8370 rows over ~180 distinct timestamps in prod). PostgREST
      // `.range()` pagination is non-deterministic on ties, so
      // ordering by `created_at` alone silently drops rows between
      // pages. `id` is the primary key — strict tiebreaker, stable
      // pagination.
      .order('created_at', { ascending: true })
      .order('id', { ascending: true })
      .range(from, from + FILES_PAGE_SIZE - 1);
    if (filesErr) throw new Error(filesErr.message);
    const page = files ?? [];
    if (page.length === 0) break;

    for (const row of page) {
      const typed = row as {
        id: string;
        candidate_id: string;
        parsed_text: string;
      };
      const expectedHash = extractionContentHash(typed.parsed_text, model, promptVersion);
      if (existingHashes.has(expectedHash)) continue;
      out.push({
        file_id: typed.id,
        candidate_id: typed.candidate_id,
        parsed_text: typed.parsed_text,
      });
      if (out.length >= limit) return out;
    }
    // Advance by what the server actually returned, not by the
    // requested page size — PostgREST `max_rows` may cap the page
    // below FILES_PAGE_SIZE. Termination relies on an empty page
    // (next iteration's range falls past the last row).
    from += page.length;
  }
  return out;
}

// Matches PostgREST's default `max_rows=1000`. Using exactly the
// server cap means each request returns at most one page and we
// don't waste round-trips asking for more than the server delivers.
const FILES_PAGE_SIZE = 1000;
