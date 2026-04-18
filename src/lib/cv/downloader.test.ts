/**
 * Unit tests for the CV downloader.
 *
 * Contract: given a Teamtailor signed URL + metadata, the downloader
 *   1. fetches the binary,
 *   2. hashes it (SHA-256 hex),
 *   3. compares against existingHash — if equal, skips the upload,
 *   4. otherwise uploads to `candidate-cvs/<candidate_uuid>/<file_uuid>.<ext>`
 *      using `upsert: true` (so re-syncs of changed binaries overwrite).
 *
 * Tested against a fake fetch + a minimal StorageBucket mock to keep
 * these as true unit tests (no live Supabase needed).
 */
import { describe, expect, it, vi } from 'vitest';

import { downloadAndStore, extractFileType, BUCKET } from './downloader';

type UploadCall = {
  path: string;
  body: Uint8Array | Buffer;
  opts?: { contentType?: string; upsert?: boolean };
};

function makeStorage(): {
  calls: UploadCall[];
  bucket: {
    upload: (
      path: string,
      body: Uint8Array,
      opts?: UploadCall['opts'],
    ) => Promise<{ data: unknown; error: null }>;
  };
} {
  const calls: UploadCall[] = [];
  return {
    calls,
    bucket: {
      upload: async (path, body, opts) => {
        calls.push({ path, body, opts });
        return { data: { path }, error: null };
      },
    },
  };
}

function makeFetch(bodyBytes: Uint8Array, opts: { status?: number } = {}): typeof fetch {
  const status = opts.status ?? 200;
  const ab = new ArrayBuffer(bodyBytes.byteLength);
  new Uint8Array(ab).set(bodyBytes);
  return (async () => new Response(ab, { status })) as unknown as typeof fetch;
}

const CANDIDATE_ID = 'c0000000-0000-0000-0000-00000000000a';
const FILE_UUID = 'f0000000-0000-0000-0000-0000000000a1';
const SIGNED_URL = 'https://teamtailor-na-maroon.s3.us-west-2.amazonaws.com/uploads/x?sig=1';

describe('extractFileType', () => {
  it('returns lowercase extension without dot', () => {
    expect(extractFileType('resume.PDF')).toBe('pdf');
    expect(extractFileType('Carta de presentación.docx')).toBe('docx');
    expect(extractFileType('vairix.XLSX')).toBe('xlsx');
  });
  it('returns "bin" when file has no extension', () => {
    expect(extractFileType('resume')).toBe('bin');
  });
  it('returns "bin" for hidden-dotfile-style with no ext', () => {
    expect(extractFileType('.hidden')).toBe('bin');
  });
});

describe('downloadAndStore — adversarial', () => {
  it('rejects when fetch returns non-2xx', async () => {
    const { bucket } = makeStorage();
    const fetchImpl = makeFetch(new Uint8Array([0x25, 0x50, 0x44, 0x46]), { status: 403 });
    await expect(
      downloadAndStore({
        url: SIGNED_URL,
        fileName: 'a.pdf',
        candidateId: CANDIDATE_ID,
        fileUuid: FILE_UUID,
        existingHash: null,
        deps: { fetch: fetchImpl, storage: bucket },
      }),
    ).rejects.toThrow(/HTTP 403/);
  });

  it('skips upload when existing hash matches newly-downloaded binary', async () => {
    // Empty body — sha256 is well-known.
    const emptySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
    const { calls, bucket } = makeStorage();
    const fetchImpl = makeFetch(new Uint8Array());
    const result = await downloadAndStore({
      url: SIGNED_URL,
      fileName: 'a.pdf',
      candidateId: CANDIDATE_ID,
      fileUuid: FILE_UUID,
      existingHash: emptySha256,
      deps: { fetch: fetchImpl, storage: bucket },
    });
    expect(result.uploadedFresh).toBe(false);
    expect(result.contentHash).toBe(emptySha256);
    expect(calls.length).toBe(0);
  });

  it('uploads when no existing hash', async () => {
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]); // "%PDF-"
    const { calls, bucket } = makeStorage();
    const fetchImpl = makeFetch(bytes);
    const result = await downloadAndStore({
      url: SIGNED_URL,
      fileName: 'resume.pdf',
      candidateId: CANDIDATE_ID,
      fileUuid: FILE_UUID,
      existingHash: null,
      deps: { fetch: fetchImpl, storage: bucket },
    });
    expect(result.uploadedFresh).toBe(true);
    expect(result.fileType).toBe('pdf');
    expect(result.fileSizeBytes).toBe(bytes.length);
    expect(result.storagePath).toBe(`${CANDIDATE_ID}/${FILE_UUID}.pdf`);
    expect(calls.length).toBe(1);
    expect(calls[0]?.path).toBe(`${CANDIDATE_ID}/${FILE_UUID}.pdf`);
    expect(calls[0]?.opts?.upsert).toBe(true);
  });

  it('uploads when existing hash differs (content changed on TT)', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const { calls, bucket } = makeStorage();
    const fetchImpl = makeFetch(bytes);
    const result = await downloadAndStore({
      url: SIGNED_URL,
      fileName: 'resume.pdf',
      candidateId: CANDIDATE_ID,
      fileUuid: FILE_UUID,
      existingHash: 'deadbeef-not-matching-hash',
      deps: { fetch: fetchImpl, storage: bucket },
    });
    expect(result.uploadedFresh).toBe(true);
    expect(calls.length).toBe(1);
  });

  it('rejects when storage.upload returns error', async () => {
    const { bucket } = makeStorage();
    // Replace upload with one that errors.
    const errBucket = {
      upload: async () => ({
        data: null,
        error: { message: 'bucket missing', name: 'StorageError' },
      }),
    };
    void bucket;
    const fetchImpl = makeFetch(new Uint8Array([1, 2, 3]));
    await expect(
      downloadAndStore({
        url: SIGNED_URL,
        fileName: 'a.pdf',
        candidateId: CANDIDATE_ID,
        fileUuid: FILE_UUID,
        existingHash: null,
        deps: { fetch: fetchImpl, storage: errBucket },
      }),
    ).rejects.toThrow(/bucket missing/);
  });

  it('exports BUCKET constant matching the migration', () => {
    expect(BUCKET).toBe('candidate-cvs');
  });

  it('passes an inferred Content-Type to upload for common extensions', async () => {
    const { calls, bucket } = makeStorage();
    await downloadAndStore({
      url: SIGNED_URL,
      fileName: 'sheet.xlsx',
      candidateId: CANDIDATE_ID,
      fileUuid: FILE_UUID,
      existingHash: null,
      deps: { fetch: makeFetch(new Uint8Array([1, 2, 3])), storage: bucket },
    });
    expect(calls[0]?.opts?.contentType).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
  });
});

// Dummy use to silence unused `vi` import if not needed by test runner plumbing.
void vi;
