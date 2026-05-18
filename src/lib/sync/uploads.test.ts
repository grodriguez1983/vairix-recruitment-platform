/**
 * Unit tests for makeUploadsSyncer.mapResource — the pure path.
 *
 * The upsert path depends on live Supabase + Storage, which is
 * exercised in tests/integration/sync/uploads.test.ts (pending).
 * Here we lock down the mapping contract:
 *   - missing `candidate` relationship → ParseError
 *   - missing `url` or `fileName` attribute → ParseError
 *   - `internal` absent → defaults to false (permissive)
 *   - `internal=true` preserved verbatim
 *   - buildInitialRequest uses `sort=-updated-at` (NOT a filter — the
 *     TT `/v1/uploads` endpoint rejects every `filter[*]` with code 102
 *     "not allowed", probed 2026-05-18). Cursor-based early-stop is
 *     enforced client-side via `shouldStop()`.
 */
import { describe, expect, it } from 'vitest';

import { makeUploadsSyncer } from './uploads';
import type { TTParsedResource } from '../teamtailor/types';

function resource(
  id: string,
  attrs: Record<string, unknown>,
  rels: Record<string, { data: { type: string; id: string } | null }> = {},
): TTParsedResource {
  return { id, type: 'uploads', attributes: attrs, relationships: rels };
}

const syncer = makeUploadsSyncer({
  storage: { upload: async () => ({ data: null, error: null }) },
});

describe('uploadsSyncer.mapResource', () => {
  it('rejects when candidate relationship is missing', () => {
    const r = resource('1', { url: 'https://x', fileName: 'a.pdf' }, {});
    expect(() => syncer.mapResource(r, [])).toThrow(/missing required relationship/);
  });

  it('rejects when url is missing', () => {
    const r = resource(
      '1',
      { fileName: 'a.pdf' },
      { candidate: { data: { type: 'candidates', id: 'c1' } } },
    );
    expect(() => syncer.mapResource(r, [])).toThrow(/missing required attribute "url"/);
  });

  it('rejects when fileName is missing', () => {
    const r = resource(
      '1',
      { url: 'https://x' },
      { candidate: { data: { type: 'candidates', id: 'c1' } } },
    );
    expect(() => syncer.mapResource(r, [])).toThrow(/missing required attribute "fileName"/);
  });

  it('defaults is_internal=false when attribute is absent', () => {
    const r = resource(
      '1',
      { url: 'https://x', fileName: 'a.pdf' },
      { candidate: { data: { type: 'candidates', id: 'c1' } } },
    );
    const s = syncer.mapResource(r, []);
    expect(s.is_internal).toBe(false);
    expect(s.candidate_tt_id).toBe('c1');
    expect(s.file_name).toBe('a.pdf');
  });

  it('preserves is_internal=true verbatim', () => {
    const r = resource(
      '1',
      { url: 'https://x', fileName: 'a.pdf', internal: true },
      { candidate: { data: { type: 'candidates', id: 'c1' } } },
    );
    const s = syncer.mapResource(r, []);
    expect(s.is_internal).toBe(true);
  });
});

describe('uploadsSyncer.buildInitialRequest', () => {
  it('uses sort=-updated-at (newest first) and no filter when cursor is null', () => {
    const req = syncer.buildInitialRequest(null);
    expect(req.path).toBe('/uploads');
    expect(req.params?.['page[size]']).toBe('30');
    expect(req.params?.['include']).toBe('candidate');
    expect(req.params?.['sort']).toBe('-updated-at');
    expect(req.params?.['filter[updated-at][from]']).toBeUndefined();
  });
  it('test_rejects_filter_updated_at_even_when_cursor_present (TT 102 not allowed)', () => {
    // Critical regression guard: a previous version of this syncer sent
    // `filter[updated-at][from]=<cursor>` and crashed every run-2 with
    // HTTP 400 because TT `/v1/uploads` rejects all filters. The cursor
    // is now consumed exclusively by shouldStop(), never as a filter.
    const req = syncer.buildInitialRequest('2026-04-18T00:00:00Z');
    expect(req.params?.['sort']).toBe('-updated-at');
    expect(req.params?.['filter[updated-at][from]']).toBeUndefined();
    expect(Object.keys(req.params ?? {}).some((k) => k.startsWith('filter['))).toBe(false);
  });
});

describe('uploadsSyncer.shouldStop (cursor-based early-stop)', () => {
  function withUpdatedAt(updatedAt: string): TTParsedResource {
    return {
      id: '1',
      type: 'uploads',
      attributes: { url: 'https://x', fileName: 'a.pdf', updatedAt },
      relationships: { candidate: { data: { type: 'candidates', id: 'c1' } } },
    };
  }

  it('returns false when cursor is null (full backfill, never stops)', () => {
    expect(syncer.shouldStop?.(withUpdatedAt('2026-01-01T00:00:00Z'), null)).toBe(false);
  });

  it('returns true when resource updatedAt is strictly older than cursor', () => {
    expect(syncer.shouldStop?.(withUpdatedAt('2026-04-17T23:59:59Z'), '2026-04-18T00:00:00Z')).toBe(
      true,
    );
  });

  it('returns false when resource updatedAt is equal to cursor (inclusive boundary)', () => {
    expect(syncer.shouldStop?.(withUpdatedAt('2026-04-18T00:00:00Z'), '2026-04-18T00:00:00Z')).toBe(
      false,
    );
  });

  it('returns false when resource updatedAt is newer than cursor', () => {
    expect(
      syncer.shouldStop?.(withUpdatedAt('2026-05-18T15:00:00-03:00'), '2026-04-18T00:00:00Z'),
    ).toBe(false);
  });

  it('compares timezone-aware ISO strings (not lexicographic)', () => {
    // 2026-05-18T15:00:00-03:00 == 2026-05-18T18:00:00Z, which is
    // NEWER than 2026-05-18T17:00:00Z. Lex compare on the raw strings
    // would (incorrectly) say "15:00 < 17:00 → older → stop".
    expect(
      syncer.shouldStop?.(withUpdatedAt('2026-05-18T15:00:00-03:00'), '2026-05-18T17:00:00Z'),
    ).toBe(false);
  });

  it('returns false when updatedAt attribute is missing (permissive — never stop on incomplete data)', () => {
    const r: TTParsedResource = {
      id: '1',
      type: 'uploads',
      attributes: { url: 'https://x', fileName: 'a.pdf' },
      relationships: { candidate: { data: { type: 'candidates', id: 'c1' } } },
    };
    expect(syncer.shouldStop?.(r, '2026-04-18T00:00:00Z')).toBe(false);
  });
});

describe('uploadsSyncer metadata', () => {
  it('declares entity="files" to match sync_state seed row', () => {
    expect(syncer.entity).toBe('files');
  });
  it('does not set includesSideloads (candidate is only an FK, no extra data consumed)', () => {
    expect(syncer.includesSideloads).toBeFalsy();
  });
});
