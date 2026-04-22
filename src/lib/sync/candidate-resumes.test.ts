/**
 * Unit tests for candidate-resumes downloader (ADR-018).
 *
 * Focus areas (adversarial, §4.3 Verifiable):
 *   - namespace helper never collides with numeric upload ids
 *   - absent resume URL is a silent no-op (counted, not errored)
 *   - unresolved candidate id is a data bug, counted as error but
 *     MUST NOT kill the batch
 *   - content-hash dedup short-circuits before upsert
 *   - download failure writes sync_errors and keeps processing
 *   - resulting files row has source='candidate_resume' + namespaced
 *     teamtailor_id — invariants the migration depends on
 */
import { createHash } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  downloadResumesForCandidates,
  resumeFileName,
  resumeTeamtailorId,
  type CandidateResumeDeps,
} from './candidate-resumes';
import type { StorageBucketLike } from '../cv/downloader';

type FakeFile = { id: string; teamtailor_id: string; content_hash: string | null };

interface FakeDb {
  db: unknown;
  filesUpserts: unknown[];
  syncErrors: unknown[];
  selectCalls: number;
}

function makeFakeDb(existing: FakeFile[] = []): FakeDb {
  const filesUpserts: unknown[] = [];
  const syncErrors: unknown[] = [];
  const selectCalls = 0;
  const state = { filesUpserts, syncErrors, selectCalls };

  const db = {
    from(table: string) {
      if (table === 'files') {
        return {
          select(_cols: string) {
            return {
              in(_col: string, ids: string[]) {
                state.selectCalls += 1;
                return Promise.resolve({
                  data: existing.filter((f) => ids.includes(f.teamtailor_id)),
                  error: null,
                });
              },
            };
          },
          upsert(rows: unknown[], _opts: unknown) {
            filesUpserts.push(...(rows as unknown[]));
            return Promise.resolve({ error: null });
          },
        };
      }
      if (table === 'sync_errors') {
        return {
          insert(row: unknown) {
            syncErrors.push(row);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  };

  return {
    db,
    get filesUpserts() {
      return filesUpserts;
    },
    get syncErrors() {
      return syncErrors;
    },
    get selectCalls() {
      return state.selectCalls;
    },
  } as FakeDb;
}

function makeFakeStorage(): {
  storage: StorageBucketLike;
  uploads: Array<{ path: string; bytes: Uint8Array; contentType?: string }>;
} {
  const uploads: Array<{ path: string; bytes: Uint8Array; contentType?: string }> = [];
  const storage: StorageBucketLike = {
    upload: async (path, body, opts) => {
      const bytes =
        body instanceof Uint8Array ? body : new Uint8Array(body as unknown as ArrayBufferLike);
      uploads.push({ path, bytes, contentType: opts?.contentType });
      return { data: null, error: null };
    },
  };
  return { storage, uploads };
}

function fetchReturning(body: string): typeof fetch {
  return (async (_url: string) => {
    const buf = new TextEncoder().encode(body);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

function sha256Hex(s: string): string {
  return createHash('sha256').update(new TextEncoder().encode(s)).digest('hex');
}

function makeDeps(overrides: Partial<CandidateResumeDeps> = {}): CandidateResumeDeps {
  return {
    fetch: fetchReturning('default-body'),
    storage: { upload: async () => ({ data: null, error: null }) },
    randomUuid: (() => {
      let n = 0;
      return () => {
        n += 1;
        return `uuid-${n}`;
      };
    })(),
    ...overrides,
  };
}

describe('resumeTeamtailorId', () => {
  it('namespaces with resume: prefix so it cannot collide with numeric upload ids', () => {
    expect(resumeTeamtailorId('322042')).toBe('resume:322042');
  });
  it('round-trips arbitrary candidate tt_ids', () => {
    expect(resumeTeamtailorId('abc-999')).toBe('resume:abc-999');
  });
});

describe('resumeFileName', () => {
  it('produces a .pdf file name seeded by candidate tt_id', () => {
    expect(resumeFileName('322042')).toBe('resume-322042.pdf');
  });
});

describe('downloadResumesForCandidates — empty / no-resume inputs', () => {
  it('returns zeroed result and never queries the DB when input is empty', async () => {
    const fake = makeFakeDb();
    const { storage } = makeFakeStorage();
    const fetchSpy = vi.fn(fetchReturning('x'));

    const result = await downloadResumesForCandidates(
      [],
      new Map(),
      fake.db as never,
      makeDeps({ storage, fetch: fetchSpy as unknown as typeof fetch }),
    );

    expect(result).toEqual({ attempted: 0, upserted: 0, skippedNoUrl: 0, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.selectCalls).toBe(0);
    expect(fake.filesUpserts).toHaveLength(0);
  });

  it('skips candidates without a resume URL (null AND empty string) without fetching', async () => {
    const fake = makeFakeDb();
    const { storage } = makeFakeStorage();
    const fetchSpy = vi.fn(fetchReturning('x'));

    const result = await downloadResumesForCandidates(
      [
        { candidate_tt_id: 'c1', resume_url: null },
        { candidate_tt_id: 'c2', resume_url: '' },
      ],
      new Map([
        ['c1', 'uuid-c1'],
        ['c2', 'uuid-c2'],
      ]),
      fake.db as never,
      makeDeps({ storage, fetch: fetchSpy as unknown as typeof fetch }),
    );

    expect(result).toEqual({ attempted: 0, upserted: 0, skippedNoUrl: 2, errors: 0 });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.filesUpserts).toHaveLength(0);
  });
});

describe('downloadResumesForCandidates — new content path', () => {
  it('downloads, uploads to storage, and upserts a files row with source=candidate_resume', async () => {
    const fake = makeFakeDb();
    const { storage, uploads } = makeFakeStorage();

    const result = await downloadResumesForCandidates(
      [{ candidate_tt_id: '322042', resume_url: 'https://tt.example/r/abc?sig=xyz' }],
      new Map([['322042', 'cand-uuid-1']]),
      fake.db as never,
      makeDeps({
        fetch: fetchReturning('PDF-BYTES'),
        storage,
        randomUuid: () => 'file-uuid-1',
      }),
    );

    expect(result.attempted).toBe(1);
    expect(result.upserted).toBe(1);
    expect(result.errors).toBe(0);
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.path).toBe('cand-uuid-1/file-uuid-1.pdf');
    expect(uploads[0]!.contentType).toBe('application/pdf');

    expect(fake.filesUpserts).toHaveLength(1);
    const row = fake.filesUpserts[0] as Record<string, unknown>;
    expect(row.teamtailor_id).toBe('resume:322042');
    expect(row.candidate_id).toBe('cand-uuid-1');
    expect(row.source).toBe('candidate_resume');
    expect(row.kind).toBe('cv');
    expect(row.is_internal).toBe(false);
    expect(row.content_hash).toBe(sha256Hex('PDF-BYTES'));
    expect(row.storage_path).toBe('cand-uuid-1/file-uuid-1.pdf');
    expect(row.file_type).toBe('pdf');
    expect(row.parsed_text).toBeNull();
    expect(row.parsed_at).toBeNull();
    expect(row.parse_error).toBeNull();
  });

  it('reuses the existing files.id when the row is already present (stable path across re-syncs)', async () => {
    const body = 'NEW-BYTES';
    const fake = makeFakeDb([
      { id: 'preexisting-file-uuid', teamtailor_id: 'resume:c1', content_hash: 'stale-hash' },
    ]);
    const { storage, uploads } = makeFakeStorage();

    await downloadResumesForCandidates(
      [{ candidate_tt_id: 'c1', resume_url: 'https://tt/r' }],
      new Map([['c1', 'cand-uuid-1']]),
      fake.db as never,
      makeDeps({
        fetch: fetchReturning(body),
        storage,
        randomUuid: () => 'should-not-be-used',
      }),
    );

    expect(uploads[0]!.path).toBe('cand-uuid-1/preexisting-file-uuid.pdf');
  });
});

describe('downloadResumesForCandidates — content-hash dedup', () => {
  it('skips upsert when downloaded bytes hash matches existing files.content_hash', async () => {
    const body = 'UNCHANGED';
    const hash = sha256Hex(body);
    const fake = makeFakeDb([
      { id: 'existing-uuid', teamtailor_id: 'resume:c1', content_hash: hash },
    ]);
    const { storage, uploads } = makeFakeStorage();

    const result = await downloadResumesForCandidates(
      [{ candidate_tt_id: 'c1', resume_url: 'https://tt/r' }],
      new Map([['c1', 'cand-uuid-1']]),
      fake.db as never,
      makeDeps({ fetch: fetchReturning(body), storage }),
    );

    expect(result.attempted).toBe(1);
    expect(result.upserted).toBe(0);
    expect(result.errors).toBe(0);
    expect(uploads).toHaveLength(0);
    expect(fake.filesUpserts).toHaveLength(0);
  });
});

describe('downloadResumesForCandidates — failure modes', () => {
  it('records sync_errors and keeps going when fetch throws', async () => {
    const fake = makeFakeDb();
    const { storage } = makeFakeStorage();
    const fetchImpl = (async (_url: string): Promise<Response> => {
      throw new Error('network borked');
    }) as unknown as typeof fetch;

    const result = await downloadResumesForCandidates(
      [
        { candidate_tt_id: 'bad', resume_url: 'https://tt/r1' },
        { candidate_tt_id: 'good', resume_url: 'https://tt/r2' },
      ],
      new Map([
        ['bad', 'uuid-bad'],
        ['good', 'uuid-good'],
      ]),
      fake.db as never,
      makeDeps({ fetch: fetchImpl, storage }),
    );

    expect(result.errors).toBeGreaterThanOrEqual(1);
    expect(fake.syncErrors).toHaveLength(2);
    const first = fake.syncErrors[0] as Record<string, unknown>;
    expect(first.entity).toBe('candidate_resumes');
    expect(first.teamtailor_id).toBe('resume:bad');
    expect(first.error_code).toBe('DownloadFailed');
    expect(String(first.error_message)).toContain('network borked');
  });

  it('counts a missing candidateIdByTtId mapping as an error without fetching', async () => {
    const fake = makeFakeDb();
    const { storage } = makeFakeStorage();
    const fetchSpy = vi.fn(fetchReturning('x'));

    const result = await downloadResumesForCandidates(
      [{ candidate_tt_id: 'ghost', resume_url: 'https://tt/r' }],
      new Map(),
      fake.db as never,
      makeDeps({ storage, fetch: fetchSpy as unknown as typeof fetch }),
    );

    expect(result.errors).toBe(1);
    expect(result.upserted).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(fake.filesUpserts).toHaveLength(0);
  });
});

describe('downloadResumesForCandidates — aggregation across mixed batch', () => {
  it('reports accurate counts when some candidates lack URL, some dedup, some upsert', async () => {
    const dedupBody = 'SAME';
    const dedupHash = sha256Hex(dedupBody);
    const fake = makeFakeDb([
      { id: 'existing-c2', teamtailor_id: 'resume:c2', content_hash: dedupHash },
    ]);
    const { storage } = makeFakeStorage();

    // Different per-URL bodies to control dedup vs fresh outcomes.
    const fetchByUrl: Record<string, string> = {
      'https://tt/r-c2': dedupBody,
      'https://tt/r-c3': 'NEW',
    };
    const fetchImpl = (async (url: string): Promise<Response> => {
      const body = fetchByUrl[url];
      if (!body) throw new Error(`unexpected url ${url}`);
      const buf = new TextEncoder().encode(body);
      return {
        ok: true,
        status: 200,
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      } as unknown as Response;
    }) as unknown as typeof fetch;

    const result = await downloadResumesForCandidates(
      [
        { candidate_tt_id: 'c1', resume_url: null },
        { candidate_tt_id: 'c2', resume_url: 'https://tt/r-c2' },
        { candidate_tt_id: 'c3', resume_url: 'https://tt/r-c3' },
      ],
      new Map([
        ['c1', 'uuid-c1'],
        ['c2', 'uuid-c2'],
        ['c3', 'uuid-c3'],
      ]),
      fake.db as never,
      makeDeps({ fetch: fetchImpl, storage, randomUuid: () => 'uuid-c3-file' }),
    );

    expect(result.skippedNoUrl).toBe(1);
    expect(result.attempted).toBe(2);
    expect(result.upserted).toBe(1);
    expect(result.errors).toBe(0);
    expect(fake.filesUpserts).toHaveLength(1);
    const row = fake.filesUpserts[0] as Record<string, unknown>;
    expect(row.teamtailor_id).toBe('resume:c3');
  });
});
