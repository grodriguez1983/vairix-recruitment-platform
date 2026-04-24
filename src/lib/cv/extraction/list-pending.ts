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
  db: SupabaseClient,
  input: ListPendingExtractionsInput,
): Promise<PendingExtractionRow[]> {
  const { model, promptVersion, limit } = input;

  const { data: existing, error: existingErr } = await db
    .from('candidate_extractions')
    .select('file_id')
    .eq('model', model)
    .eq('prompt_version', promptVersion);
  if (existingErr) throw new Error(existingErr.message);

  const excluded = new Set<string>();
  for (const row of existing ?? []) {
    const id = (row as { file_id: string | null }).file_id;
    if (typeof id === 'string' && id.length > 0) excluded.add(id);
  }

  // Pre-fetch `limit + excluded.size` so we still return `limit` rows
  // even if every row we'd want sits behind the excluded prefix.
  // Smaller values risk false-empty; larger values waste bandwidth on
  // a worker that runs infrequently.
  const fetchCap = limit + excluded.size;

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
    if (excluded.has(typed.id)) continue;
    out.push({
      file_id: typed.id,
      candidate_id: typed.candidate_id,
      parsed_text: typed.parsed_text,
    });
    if (out.length >= limit) break;
  }
  return out;
}
