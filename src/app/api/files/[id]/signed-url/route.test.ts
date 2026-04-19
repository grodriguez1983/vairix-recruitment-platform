/**
 * Tests for GET /api/files/[id]/signed-url.
 *
 * The route's job is small but security-sensitive — it mints a signed
 * URL into the private `candidate-cvs` bucket. Behavior under test:
 *   - 401 when there is no auth context
 *   - 400 when the path id is not a UUID
 *   - 404 when the file row is not visible (RLS hid it OR no such row;
 *     the route can't tell them apart and treats both as "not visible")
 *   - 410 when the file row exists but is soft-deleted
 *   - 500 when Storage refuses to sign (bubbles the message)
 *   - 200 with the signed URL + a fileName resolved from raw_data
 *
 * `getAuthUser` and `createClient` are vi.mock'd so the test never
 * touches Supabase. The shape of the mocked client matches the chained
 * builder API used inside the handler.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/lib/auth/require', () => ({
  getAuthUser: vi.fn(),
}));

vi.mock('@/lib/supabase/server', () => ({
  createClient: vi.fn(),
}));

import { getAuthUser } from '@/lib/auth/require';
import { createClient } from '@/lib/supabase/server';

import { GET } from './route';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

interface FileRow {
  storage_path: string;
  raw_data: Record<string, unknown> | null;
  kind: string;
  deleted_at: string | null;
}

interface SignResult {
  data: { signedUrl: string } | null;
  error: { message: string } | null;
}

function makeSupabaseMock(opts: {
  fileRow?: FileRow | null;
  sign?: SignResult;
}): ReturnType<typeof createClient> {
  const maybeSingle = vi.fn().mockResolvedValue({ data: opts.fileRow ?? null, error: null });
  const eq = vi.fn().mockReturnValue({ maybeSingle });
  const select = vi.fn().mockReturnValue({ eq });
  const from = vi.fn().mockReturnValue({ select });

  const createSignedUrl = vi
    .fn()
    .mockResolvedValue(opts.sign ?? { data: { signedUrl: 'https://signed.test/x' }, error: null });
  const fromStorage = vi.fn().mockReturnValue({ createSignedUrl });

  return {
    from,
    storage: { from: fromStorage },
  } as unknown as ReturnType<typeof createClient>;
}

function req(): Request {
  return new Request('http://test/api/files/x/signed-url');
}

beforeEach(() => {
  vi.mocked(getAuthUser).mockReset();
  vi.mocked(createClient).mockReset();
});

describe('GET /api/files/[id]/signed-url', () => {
  it('returns 401 when unauthenticated', async () => {
    vi.mocked(getAuthUser).mockResolvedValue(null);
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    expect(res.status).toBe(401);
    await expect(res.json()).resolves.toEqual({ error: 'unauthenticated' });
  });

  it('returns 400 when the id is not a UUID', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    const res = await GET(req() as never, { params: { id: 'not-a-uuid' } });
    expect(res.status).toBe(400);
    await expect(res.json()).resolves.toEqual({ error: 'invalid_id' });
  });

  it('rejects SQL-injection-shaped ids at the regex (defense in depth)', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    const res = await GET(req() as never, { params: { id: "' OR 1=1 --" } });
    expect(res.status).toBe(400);
  });

  it('returns 404 when the row is not visible (null from maybeSingle)', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    vi.mocked(createClient).mockReturnValue(makeSupabaseMock({ fileRow: null }));
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    expect(res.status).toBe(404);
    await expect(res.json()).resolves.toEqual({ error: 'not_found' });
  });

  it('returns 410 when the row is soft-deleted', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    vi.mocked(createClient).mockReturnValue(
      makeSupabaseMock({
        fileRow: {
          storage_path: 'cand/file.pdf',
          raw_data: null,
          kind: 'cv',
          deleted_at: '2026-01-01T00:00:00Z',
        },
      }),
    );
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    expect(res.status).toBe(410);
    await expect(res.json()).resolves.toEqual({ error: 'deleted' });
  });

  it('returns 500 when storage signing fails', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    vi.mocked(createClient).mockReturnValue(
      makeSupabaseMock({
        fileRow: {
          storage_path: 'cand/file.pdf',
          raw_data: null,
          kind: 'cv',
          deleted_at: null,
        },
        sign: { data: null, error: { message: 'object not found' } },
      }),
    );
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.error).toBe('sign_failed');
    expect(body.detail).toBe('object not found');
  });

  it('returns 200 with signed URL + manual-upload fileName', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    vi.mocked(createClient).mockReturnValue(
      makeSupabaseMock({
        fileRow: {
          storage_path: 'cand-id/file-id.pdf',
          raw_data: { originalFileName: 'Juan_Perez_CV.pdf' },
          kind: 'vairix_cv_sheet',
          deleted_at: null,
        },
      }),
    );
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      url: string;
      fileName: string;
      kind: string;
      expiresAt: string;
    };
    expect(body.url).toBe('https://signed.test/x');
    expect(body.fileName).toBe('Juan_Perez_CV.pdf');
    expect(body.kind).toBe('vairix_cv_sheet');
    // Should be ~1h in the future.
    const ms = new Date(body.expiresAt).getTime() - Date.now();
    expect(ms).toBeGreaterThan(60 * 59 * 1000);
    expect(ms).toBeLessThan(60 * 61 * 1000);
  });

  it('falls back to raw_data.attributes.fileName for TT-synced uploads', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    vi.mocked(createClient).mockReturnValue(
      makeSupabaseMock({
        fileRow: {
          storage_path: 'cand-id/file-id.pdf',
          raw_data: { attributes: { fileName: 'tt_resume.pdf' } },
          kind: 'cv',
          deleted_at: null,
        },
      }),
    );
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    const body = (await res.json()) as { fileName: string };
    expect(body.fileName).toBe('tt_resume.pdf');
  });

  it('falls back to the storage_path basename when raw_data is empty', async () => {
    vi.mocked(getAuthUser).mockResolvedValue({
      userId: 'u',
      email: 'r@v',
      role: 'recruiter',
    });
    vi.mocked(createClient).mockReturnValue(
      makeSupabaseMock({
        fileRow: {
          storage_path: 'cand-id/last-segment.docx',
          raw_data: null,
          kind: 'cv',
          deleted_at: null,
        },
      }),
    );
    const res = await GET(req() as never, { params: { id: VALID_UUID } });
    const body = (await res.json()) as { fileName: string };
    expect(body.fileName).toBe('last-segment.docx');
  });
});
