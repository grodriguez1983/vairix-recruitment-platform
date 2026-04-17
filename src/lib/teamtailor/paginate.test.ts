/**
 * Unit tests for the generic paginate() async iterator.
 *
 * These tests use an in-memory `fetchPage` stub — no HTTP involved.
 * Client-level integration (headers, rate limit, retry) is covered
 * separately in client.test.ts with MSW.
 */
import { describe, expect, it, vi } from 'vitest';
import { paginate } from './paginate';
import type { TTParsedDocument, TTParsedResource } from './types';

function makeDoc(ids: string[], nextUrl: string | null): TTParsedDocument {
  const data: TTParsedResource[] = ids.map((id) => ({
    id,
    type: 'candidates',
    attributes: { index: Number(id) },
  }));
  return { data, nextUrl };
}

describe('paginate', () => {
  it('yields every resource across multiple pages in order', async () => {
    const pages: Record<string, TTParsedDocument> = {
      'https://api/candidates?page=1': makeDoc(['1', '2'], 'https://api/candidates?page=2'),
      'https://api/candidates?page=2': makeDoc(['3', '4'], 'https://api/candidates?page=3'),
      'https://api/candidates?page=3': makeDoc(['5'], null),
    };
    const fetchPage = vi.fn(async (url: string) => {
      const doc = pages[url];
      if (!doc) throw new Error(`unexpected url: ${url}`);
      return doc;
    });

    const ids: string[] = [];
    for await (const r of paginate(fetchPage, 'https://api/candidates?page=1')) {
      ids.push(r.id);
    }

    expect(ids).toEqual(['1', '2', '3', '4', '5']);
    expect(fetchPage).toHaveBeenCalledTimes(3);
  });

  it('terminates immediately when first page has no next', async () => {
    const fetchPage = vi.fn(async () => makeDoc(['only'], null));
    const ids: string[] = [];
    for await (const r of paginate(fetchPage, 'https://api/candidates')) {
      ids.push(r.id);
    }
    expect(ids).toEqual(['only']);
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('handles empty pages without emitting but follows next', async () => {
    const pages: Record<string, TTParsedDocument> = {
      'https://api/a': makeDoc([], 'https://api/b'),
      'https://api/b': makeDoc(['x'], null),
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]!);
    const ids: string[] = [];
    for await (const r of paginate(fetchPage, 'https://api/a')) ids.push(r.id);
    expect(ids).toEqual(['x']);
  });

  it('stops fetching when the consumer breaks out early', async () => {
    const pages: Record<string, TTParsedDocument> = {
      'https://api/p1': makeDoc(['1', '2'], 'https://api/p2'),
      'https://api/p2': makeDoc(['3'], null),
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]!);
    for await (const r of paginate(fetchPage, 'https://api/p1')) {
      if (r.id === '1') break;
    }
    // Only the first page should have been fetched.
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by fetchPage', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    const iter = paginate(fetchPage, 'https://api/x')[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('boom');
  });
});
