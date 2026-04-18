/**
 * Unit tests for paginateWithIncluded() — variant of paginate that
 * preserves the JSON:API `included` array alongside each primary
 * resource yielded.
 *
 * Rationale (ADR-010 §2): syncers that need sideloaded resources
 * (e.g. candidates with custom-field-values) cannot use the
 * resource-only paginate() because it discards `included`. The new
 * iterator yields `{ resource, included }` per primary resource.
 * The `included` array is the one from the page the resource belongs
 * to (repeated for every resource of that page).
 */
import { describe, expect, it, vi } from 'vitest';

import { paginateWithIncluded } from './paginate-with-included';
import type { TTParsedDocument, TTParsedResource } from './types';

function makePage(
  ids: string[],
  nextUrl: string | null,
  included: TTParsedResource[] = [],
): TTParsedDocument {
  const data: TTParsedResource[] = ids.map((id) => ({
    id,
    type: 'candidates',
    attributes: { index: Number(id) },
  }));
  return { data, nextUrl, included };
}

describe('paginateWithIncluded', () => {
  it('yields {resource, included} for every primary resource', async () => {
    const page1Included: TTParsedResource[] = [
      { id: 'cv-1', type: 'custom-field-values', attributes: { value: 'A' } },
    ];
    const pages: Record<string, TTParsedDocument> = {
      'https://api/p1': makePage(['1', '2'], null, page1Included),
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]!);

    const rows: Array<{ id: string; includedIds: string[] }> = [];
    for await (const { resource, included } of paginateWithIncluded(
      fetchPage,
      'https://api/p1',
    )) {
      rows.push({ id: resource.id, includedIds: included.map((r) => r.id) });
    }

    expect(rows).toEqual([
      { id: '1', includedIds: ['cv-1'] },
      { id: '2', includedIds: ['cv-1'] },
    ]);
  });

  it('walks multiple pages and carries each page own included', async () => {
    const inc1: TTParsedResource[] = [
      { id: 'cv-a', type: 'custom-field-values', attributes: { value: 'A' } },
    ];
    const inc2: TTParsedResource[] = [
      { id: 'cv-b', type: 'custom-field-values', attributes: { value: 'B' } },
      { id: 'cv-c', type: 'custom-field-values', attributes: { value: 'C' } },
    ];
    const pages: Record<string, TTParsedDocument> = {
      'https://api/p1': makePage(['1'], 'https://api/p2', inc1),
      'https://api/p2': makePage(['2'], null, inc2),
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]!);

    const rows: Array<{ id: string; includedIds: string[] }> = [];
    for await (const { resource, included } of paginateWithIncluded(
      fetchPage,
      'https://api/p1',
    )) {
      rows.push({ id: resource.id, includedIds: included.map((r) => r.id) });
    }

    expect(rows).toEqual([
      { id: '1', includedIds: ['cv-a'] },
      { id: '2', includedIds: ['cv-b', 'cv-c'] },
    ]);
    expect(fetchPage).toHaveBeenCalledTimes(2);
  });

  it('yields resources from a page with empty included as empty array, not undefined', async () => {
    // Teamtailor omits `included` when there are no sideloaded
    // resources. We normalize to [] so consumers can always iterate.
    const pages: Record<string, TTParsedDocument> = {
      'https://api/p1': { data: [{ id: '1', type: 'candidates', attributes: {} }], nextUrl: null },
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]!);

    const iter = paginateWithIncluded(fetchPage, 'https://api/p1')[Symbol.asyncIterator]();
    const first = await iter.next();
    expect(first.done).toBe(false);
    expect(first.value!.included).toEqual([]);
  });

  it('stops fetching when the consumer breaks out early', async () => {
    const pages: Record<string, TTParsedDocument> = {
      'https://api/p1': makePage(['1', '2'], 'https://api/p2'),
      'https://api/p2': makePage(['3'], null),
    };
    const fetchPage = vi.fn(async (url: string) => pages[url]!);

    for await (const { resource } of paginateWithIncluded(fetchPage, 'https://api/p1')) {
      if (resource.id === '1') break;
    }
    expect(fetchPage).toHaveBeenCalledTimes(1);
  });

  it('propagates errors thrown by fetchPage', async () => {
    const fetchPage = vi.fn(async () => {
      throw new Error('boom');
    });
    const iter = paginateWithIncluded(fetchPage, 'https://api/x')[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow('boom');
  });
});
