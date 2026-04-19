/**
 * CV parse worker runtime.
 *
 * Processes `files` rows where the binary landed via F1-007 (uploads
 * syncer or the admin manual upload endpoint) but no parser has run
 * yet — i.e. `deleted_at IS NULL AND parsed_text IS NULL AND
 * parse_error IS NULL`.
 *
 * For each row:
 *   1. Download the binary from Storage by `storage_path`.
 *   2. Dispatch to the right parser via `parseCvBuffer`.
 *   3. Persist the outcome in `files`: on success `parsed_text` gets
 *      the normalized text; on failure `parse_error` gets a stable
 *      error code. Either way `parsed_at` is stamped so the row is
 *      no longer "pending" — re-runs require an explicit
 *      `parse_error = null` to retry.
 *
 * All I/O is injected (`CvParseWorkerDeps`) so unit tests don't need
 * Supabase or real PDFs. The CLI entry point (`src/scripts/parse-cvs.ts`)
 * wires the real service-role client, Storage bucket, and pdf-parse
 * + mammoth.
 */
import { parseCvBuffer, type CvParseErrorCode, type CvParserDeps } from './parse';

export interface CvParseWorkerDeps {
  /** Returns up to `limit` pending rows, oldest first. */
  listPending: (limit: number) => Promise<
    Array<{
      id: string;
      storage_path: string;
      file_type: string;
    }>
  >;
  /** Downloads a binary by its storage_path. Must throw on failure. */
  download: (storagePath: string) => Promise<Buffer>;
  /** Persists the outcome of a single file. */
  update: (
    id: string,
    patch: {
      parsed_text: string | null;
      parse_error: CvParseErrorCode | null;
      parsed_at: string;
    },
  ) => Promise<void>;
  /** Injected parsers for pdf/docx. */
  parser: CvParserDeps;
  /** Clock for `parsed_at`. Defaults to `() => new Date()`. */
  now?: () => Date;
}

export interface CvParseRunOptions {
  /** Max rows to pull in this run. Defaults to 50. */
  batchSize?: number;
}

export interface CvParseRunResult {
  processed: number;
  parsed: number;
  errored: number;
}

export async function runCvParseWorker(
  deps: CvParseWorkerDeps,
  options: CvParseRunOptions = {},
): Promise<CvParseRunResult> {
  const batchSize = options.batchSize ?? 50;
  const now = deps.now ?? (() => new Date());
  const pending = await deps.listPending(batchSize);

  let parsed = 0;
  let errored = 0;

  for (const row of pending) {
    const parsedAt = now().toISOString();

    let buffer: Buffer;
    try {
      buffer = await deps.download(row.storage_path);
    } catch {
      // Treat download failure like a parse failure for classification
      // purposes — both prevent us from producing text. The caller can
      // reset parse_error to retry once the underlying cause (missing
      // object, bucket ACL, etc.) is fixed.
      await deps.update(row.id, {
        parsed_text: null,
        parse_error: 'parse_failure',
        parsed_at: parsedAt,
      });
      errored += 1;
      continue;
    }

    const result = await parseCvBuffer(row.file_type, buffer, deps.parser);
    if (result.status === 'ok') {
      await deps.update(row.id, {
        parsed_text: result.text,
        parse_error: null,
        parsed_at: parsedAt,
      });
      parsed += 1;
    } else {
      await deps.update(row.id, {
        parsed_text: null,
        parse_error: result.code,
        parsed_at: parsedAt,
      });
      errored += 1;
    }
  }

  return { processed: pending.length, parsed, errored };
}
