/**
 * Adversarial tests for `runChunked`. The helper exists to defend the
 * embeddings workers against PostgREST's `URI too long` when
 * `.in(column, ids)` is called with 400+ UUIDs (see chunked-in.ts
 * header for the 2026-04-24 incident).
 *
 * Tests target the *contract* — "same output as a single .in() call,
 * but split into at most K ids per request" — without caring about
 * the loop shape. Edge cases come first: zero ids, boundary sizes,
 * invalid chunk sizes, fetcher errors.
 */
import { describe, expect, it, vi } from 'vitest';

import { IN_QUERY_CHUNK_SIZE, runChunked } from './chunked-in';

type Row = { id: string };

function ids(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `id-${String(i).padStart(4, '0')}`);
}

describe('runChunked', () => {
  it('returns empty array and never calls fetch when ids is empty', async () => {
    const fetch = vi.fn<(chunk: string[]) => Promise<Row[]>>();
    const out = await runChunked([], 100, fetch);
    expect(out).toEqual([]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('fires a single fetch when ids fit in one chunk', async () => {
    const fetch = vi.fn(async (chunk: string[]): Promise<Row[]> => chunk.map((id) => ({ id })));
    const out = await runChunked(ids(50), 100, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenNthCalledWith(1, ids(50));
    expect(out).toHaveLength(50);
  });

  it('fires exactly one fetch when ids.length === chunkSize (boundary)', async () => {
    const fetch = vi.fn(async (chunk: string[]): Promise<Row[]> => chunk.map((id) => ({ id })));
    await runChunked(ids(100), 100, fetch);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('chunks into groups of at most chunkSize with the remainder in the last chunk', async () => {
    const seen: number[] = [];
    const fetch = vi.fn(async (chunk: string[]): Promise<Row[]> => {
      seen.push(chunk.length);
      return chunk.map((id) => ({ id }));
    });
    await runChunked(ids(201), 100, fetch);
    expect(seen).toEqual([100, 100, 1]);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it('preserves order of results across chunk boundaries', async () => {
    const fetch = async (chunk: string[]): Promise<Row[]> => chunk.map((id) => ({ id }));
    const input = ids(205);
    const out = await runChunked(input, 100, fetch);
    expect(out.map((r) => r.id)).toEqual(input);
  });

  it('passes chunks to fetch that are subsets of the input, in the input order', async () => {
    const chunks: string[][] = [];
    const fetch = async (chunk: string[]): Promise<Row[]> => {
      chunks.push([...chunk]);
      return [];
    };
    const input = ids(250);
    await runChunked(input, 100, fetch);
    expect(chunks.flat()).toEqual(input);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });

  it('rejects chunkSize of zero', async () => {
    await expect(runChunked(ids(5), 0, async () => [])).rejects.toThrow(/positive integer/);
  });

  it('rejects negative chunkSize', async () => {
    await expect(runChunked(ids(5), -10, async () => [])).rejects.toThrow(/positive integer/);
  });

  it('rejects non-integer chunkSize', async () => {
    await expect(runChunked(ids(5), 50.5, async () => [])).rejects.toThrow(/positive integer/);
  });

  it('surfaces fetcher errors without swallowing or wrapping', async () => {
    const boom = new Error('supabase exploded');
    const fetch = async (): Promise<Row[]> => {
      throw boom;
    };
    await expect(runChunked(ids(10), 5, fetch)).rejects.toBe(boom);
  });

  it('stops issuing further fetches after the first failure', async () => {
    const calls: number[] = [];
    const fetch = async (chunk: string[]): Promise<Row[]> => {
      calls.push(chunk.length);
      throw new Error('nope');
    };
    await expect(runChunked(ids(300), 100, fetch)).rejects.toThrow('nope');
    // Only the first chunk got issued; subsequent ones aborted.
    expect(calls).toEqual([100]);
  });

  it('IN_QUERY_CHUNK_SIZE keeps a 500-uuid batch under the PostgREST URL budget', () => {
    // A UUID is 36 chars; PostgREST encodes it as `"..."` + comma
    // inside the `in.(...)` list — call it ~40 chars per id after
    // URL encoding. The 16 KB default budget minus ~1 KB of base URL
    // and other filters leaves ~15 KB for the value list. With the
    // current chunk size, a single chunk consumes well under that.
    const approxBytesPerUuid = 40;
    const budgetBytes = 15_000;
    expect(IN_QUERY_CHUNK_SIZE * approxBytesPerUuid).toBeLessThan(budgetBytes);
  });
});
