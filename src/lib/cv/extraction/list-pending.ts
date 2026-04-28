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
  const { data: existing, error: existingErr } = await db
    .from('candidate_extractions')
    .select('content_hash')
    .eq('model', model)
    .eq('prompt_version', promptVersion);
  if (existingErr) throw new Error(existingErr.message);

  const existingHashes = new Set<string>();
  for (const row of existing ?? []) {
    const hash = (row as { content_hash: string | null }).content_hash;
    if (typeof hash === 'string' && hash.length > 0) existingHashes.add(hash);
  }

  // Pre-fetch `limit + existingHashes.size` so we still return `limit`
  // rows even if every row we'd want sits behind already-extracted
  // files. Smaller values risk false-empty.
  const fetchCap = limit + existingHashes.size;

  const { data: files, error: filesErr } = await db
    .from('files')
    .select('id, candidate_id, parsed_text')
    .is('deleted_at', null)
    .not('parsed_text', 'is', null)
    .is('parse_error', null)
    .order('created_at', { ascending: true })
    .limit(fetchCap);
  if (filesErr) throw new Error(filesErr.message);

  const out: PendingExtractionRow[] = [];
  for (const row of files ?? []) {
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
    if (out.length >= limit) break;
  }
  return out;
}
