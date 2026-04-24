/**
 * Helper to fan out a single logical `.in(column, ids)` query as
 * multiple smaller queries whose concatenated results preserve the
 * caller's semantics.
 *
 * Context (incident 2026-04-24): `src/lib/embeddings/*-worker.ts`
 * were calling `.in('id', candidateIds)` with full pages of up to
 * `batchSize=500` UUIDs. PostgREST + Node ship with a default URL
 * budget of ~16 KB, and a 500-element `in.(...)` list consumes ~20 KB
 * just for the value list — so past ~400 candidates the request
 * aborts with `URI too long`. Every `.in()` in the embeddings path
 * was vulnerable.
 *
 * Instead of each call site open-coding a for-loop and stitching
 * results, they delegate to `runChunked`: the caller hands in the
 * full id list, a chunk size, and a `fetch(chunk)` function that
 * runs one query per chunk. The helper concatenates results in the
 * same order the chunks were issued.
 *
 * IMPORTANT: the helper does not dedupe or reorder. Callers that
 * need invariants beyond "same rows as a single .in() would have
 * returned" must enforce them themselves.
 */

/**
 * Maximum number of ids packed into a single `.in()` query. Chosen so
 * that a list of UUIDs (36 chars + ~3 chars of encoding overhead each)
 * stays well below PostgREST's default 16 KB URL budget with room to
 * spare for the rest of the URL (base + path + other filters).
 *
 *   100 uuids ≈ 4 KB of value list → safe margin.
 */
export const IN_QUERY_CHUNK_SIZE = 100;

/**
 * Runs `fetch` once per chunk of `ids` (size ≤ `chunkSize`) and
 * returns the concatenation of all results.
 *
 * - Empty `ids` ⇒ returns `[]` without invoking `fetch`.
 * - `chunkSize` must be a positive integer; otherwise throws.
 * - Errors from `fetch` propagate as-is; no partial results are
 *   returned when a chunk fails.
 */
export async function runChunked<T>(
  ids: readonly string[],
  chunkSize: number,
  fetch: (chunk: string[]) => Promise<T[]>,
): Promise<T[]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`runChunked: chunkSize must be a positive integer, got ${chunkSize}`);
  }
  if (ids.length === 0) return [];

  const out: T[] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    const chunk = ids.slice(i, i + chunkSize);
    const rows = await fetch(chunk);
    for (const row of rows) out.push(row);
  }
  return out;
}
