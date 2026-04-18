/**
 * CV downloader.
 *
 * Fetches a binary from a short-lived URL (typically a Teamtailor
 * S3 signed URL), hashes it with SHA-256, and uploads it to the
 * `candidate-cvs` Storage bucket when its hash differs from the
 * caller-provided `existingHash`. No-op when the hash matches
 * (ADR-006 §2: content-addressed idempotency).
 *
 * Pure with respect to I/O: both `fetch` and the Storage bucket are
 * injected (`DownloaderDeps`) so unit tests can run without network
 * or a live Supabase. Production call sites pass
 *   - `globalThis.fetch`
 *   - `supabase.storage.from(BUCKET)` (service-role client).
 */
import { createHash } from 'node:crypto';

export const BUCKET = 'candidate-cvs';

export interface StorageBucketLike {
  upload(
    path: string,
    body: Uint8Array | Buffer,
    opts?: { contentType?: string; upsert?: boolean },
  ): Promise<{ data: unknown; error: { message: string; name?: string } | null }>;
}

export interface DownloaderDeps {
  fetch: typeof fetch;
  storage: StorageBucketLike;
}

export interface DownloadResult {
  storagePath: string;
  contentHash: string;
  fileSizeBytes: number;
  /** Lowercase extension without leading dot (`pdf`, `docx`, `xlsx`, …) or `bin`. */
  fileType: string;
  /** false when `existingHash` matched the downloaded bytes — no upload happened. */
  uploadedFresh: boolean;
}

export interface DownloadArgs {
  url: string;
  fileName: string;
  candidateId: string;
  fileUuid: string;
  existingHash: string | null;
  deps: DownloaderDeps;
}

/**
 * Extracts the lowercase extension without leading dot.
 *   `Resume.PDF`  → `pdf`
 *   `resume`      → `bin`
 *   `.hidden`     → `bin` (leading-dot-only, no real extension)
 */
export function extractFileType(fileName: string): string {
  const idx = fileName.lastIndexOf('.');
  if (idx <= 0 || idx === fileName.length - 1) return 'bin';
  return fileName.slice(idx + 1).toLowerCase();
}

const MIME_BY_EXT: Record<string, string> = {
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  csv: 'text/csv',
  txt: 'text/plain',
  rtf: 'application/rtf',
};

function inferContentType(ext: string): string {
  return MIME_BY_EXT[ext] ?? 'application/octet-stream';
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export async function downloadAndStore(args: DownloadArgs): Promise<DownloadResult> {
  const { url, fileName, candidateId, fileUuid, existingHash, deps } = args;

  const res = await deps.fetch(url);
  if (!res.ok) {
    throw new Error(`CV download failed: HTTP ${res.status} for ${url}`);
  }
  const arrayBuf = await res.arrayBuffer();
  const bytes = new Uint8Array(arrayBuf);

  const contentHash = sha256Hex(bytes);
  const fileType = extractFileType(fileName);
  const storagePath = `${candidateId}/${fileUuid}.${fileType}`;

  if (existingHash !== null && existingHash === contentHash) {
    return {
      storagePath,
      contentHash,
      fileSizeBytes: bytes.byteLength,
      fileType,
      uploadedFresh: false,
    };
  }

  const { error } = await deps.storage.upload(storagePath, bytes, {
    contentType: inferContentType(fileType),
    upsert: true,
  });
  if (error) {
    throw new Error(`CV storage upload failed: ${error.message}`);
  }

  return {
    storagePath,
    contentHash,
    fileSizeBytes: bytes.byteLength,
    fileType,
    uploadedFresh: true,
  };
}
