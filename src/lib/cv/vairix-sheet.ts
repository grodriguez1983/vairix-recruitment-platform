/**
 * VAIRIX CV sheet — validation helpers shared between the upload
 * API route and its unit tests.
 *
 * The sheet is a candidate-specific spreadsheet (xlsx/xls/csv) or a
 * PDF exported from the Google Sheet linked in the Teamtailor
 * interview question `Información para CV` (q=24016). See
 * docs/teamtailor-api-notes.md §5.6b and ADR-010.
 */

export const VAIRIX_SHEET_MAX_BYTES = 10 * 1024 * 1024; // 10 MB

/**
 * Whitelisted extensions for VAIRIX-sheet uploads. Mirrors the MIME
 * list on the `candidate-cvs` bucket but scoped down to the subset
 * that makes sense for a VAIRIX sheet (no raw DOCX CVs here).
 */
export const VAIRIX_SHEET_EXTS = ['xlsx', 'xls', 'csv', 'pdf'] as const;

export type VairixSheetExt = (typeof VAIRIX_SHEET_EXTS)[number];

export type VairixSheetValidationError =
  | 'no_file'
  | 'empty_file'
  | 'file_too_large'
  | 'unsupported_extension';

export interface VairixSheetValidationResult {
  ok: true;
  ext: VairixSheetExt;
  sizeBytes: number;
}

export interface VairixSheetValidationFailure {
  ok: false;
  code: VairixSheetValidationError;
}

export function extensionOf(fileName: string): string {
  const i = fileName.lastIndexOf('.');
  if (i <= 0 || i === fileName.length - 1) return '';
  return fileName.slice(i + 1).toLowerCase();
}

export function validateVairixSheet(opts: {
  fileName: string | null;
  sizeBytes: number;
}): VairixSheetValidationResult | VairixSheetValidationFailure {
  if (!opts.fileName || opts.fileName.length === 0) {
    return { ok: false, code: 'no_file' };
  }
  if (opts.sizeBytes === 0) {
    return { ok: false, code: 'empty_file' };
  }
  if (opts.sizeBytes > VAIRIX_SHEET_MAX_BYTES) {
    return { ok: false, code: 'file_too_large' };
  }
  const ext = extensionOf(opts.fileName);
  if (!(VAIRIX_SHEET_EXTS as readonly string[]).includes(ext)) {
    return { ok: false, code: 'unsupported_extension' };
  }
  return { ok: true, ext: ext as VairixSheetExt, sizeBytes: opts.sizeBytes };
}
