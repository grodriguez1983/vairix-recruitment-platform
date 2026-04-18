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
 *   - buildInitialRequest carries the cursor as `filter[updated-at][from]`
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
  it('omits cursor param when cursor is null', () => {
    const req = syncer.buildInitialRequest(null);
    expect(req.path).toBe('/uploads');
    expect(req.params?.['page[size]']).toBe('30');
    expect(req.params?.['include']).toBe('candidate');
    expect(req.params?.['filter[updated-at][from]']).toBeUndefined();
  });
  it('carries cursor as filter[updated-at][from]', () => {
    const iso = '2026-04-18T00:00:00Z';
    const req = syncer.buildInitialRequest(iso);
    expect(req.params?.['filter[updated-at][from]']).toBe(iso);
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
