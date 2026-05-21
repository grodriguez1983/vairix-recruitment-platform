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

export interface RunChunkedOptions {
  /**
   * Maximum number of chunks dispatched in parallel. Default 1
   * (sequential — preserves the original embeddings-worker contract).
   *
   * Use values > 1 when the chunk count is large (e.g. matching
   * pipeline at ~30 chunks for 5_000+ candidates) and the upstream
   * pool can absorb the burst. Concrete ceiling at the call site is
   * the Supabase connection pool size; Supavisor's tenant default is
   * ~15 conns, so practical values are 3–8.
   *
   * Must be a positive integer; otherwise throws.
   */
  concurrency?: number;
}

/**
 * Runs `fetch` once per chunk of `ids` (size ≤ `chunkSize`) and
 * returns the concatenation of all results.
 *
 * - Empty `ids` ⇒ returns `[]` without invoking `fetch`.
 * - `chunkSize` must be a positive integer; otherwise throws.
 * - `options.concurrency` (default 1) bounds the number of chunks
 *   in flight; the returned array still concatenates results in the
 *   same chunk-issue order regardless of completion order.
 * - Errors from `fetch` propagate as-is; on the first failure no
 *   further chunks are dispatched and pending chunks' results are
 *   discarded.
 */
export async function runChunked<T>(
  ids: readonly string[],
  chunkSize: number,
  fetch: (chunk: string[]) => Promise<T[]>,
  options: RunChunkedOptions = {},
): Promise<T[]> {
  if (!Number.isInteger(chunkSize) || chunkSize <= 0) {
    throw new Error(`runChunked: chunkSize must be a positive integer, got ${chunkSize}`);
  }
  const concurrency = options.concurrency ?? 1;
  if (!Number.isInteger(concurrency) || concurrency <= 0) {
    throw new Error(`runChunked: concurrency must be a positive integer, got ${concurrency}`);
  }
  if (ids.length === 0) return [];

  // Materialize chunks up-front so the dispatcher can address them
  // by index — the output must preserve chunk-issue order even when
  // chunks complete out of order under concurrency.
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize));
  }
  const slots: T[][] = new Array<T[]>(chunks.length);

  if (concurrency === 1) {
    // Fast path: keeps the original sequential loop shape so the
    // embeddings-worker call sites (no `concurrency` option) keep
    // their well-tested behavior unchanged.
    for (let i = 0; i < chunks.length; i += 1) {
      slots[i] = await fetch(chunks[i]!);
    }
  } else {
    // Bounded-parallel worker pool: `concurrency` workers pull the
    // next unclaimed chunk index from a shared counter until drained.
    // A single shared `firstError` short-circuits remaining work — no
    // partial results are returned on failure (matches the sequential
    // contract).
    let nextIdx = 0;
    let firstError: unknown = null;
    const worker = async (): Promise<void> => {
      while (firstError === null) {
        const myIdx = nextIdx;
        if (myIdx >= chunks.length) return;
        nextIdx = myIdx + 1;
        try {
          const rows = await fetch(chunks[myIdx]!);
          slots[myIdx] = rows;
        } catch (err) {
          if (firstError === null) firstError = err;
          return;
        }
      }
    };
    const workerCount = Math.min(concurrency, chunks.length);
    const workers: Array<Promise<void>> = [];
    for (let w = 0; w < workerCount; w += 1) workers.push(worker());
    await Promise.all(workers);
    if (firstError !== null) throw firstError;
  }

  const out: T[] = [];
  for (const slot of slots) {
    if (slot === undefined) continue;
    for (const row of slot) out.push(row);
  }
  return out;
}
