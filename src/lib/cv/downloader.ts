/**
 * CV downloader — stub for RED commit.
 *
 * Real implementation lands in the GREEN commit. This stub only
 * defines the public surface so the test file type-checks.
 */

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
  fileType: string;
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

export function extractFileType(_fileName: string): string {
  throw new Error('not implemented (RED)');
}

export async function downloadAndStore(_args: DownloadArgs): Promise<DownloadResult> {
  throw new Error('not implemented (RED)');
}
