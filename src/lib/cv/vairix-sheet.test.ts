/**
 * Unit tests for VAIRIX sheet upload validation.
 */
import { describe, expect, it } from 'vitest';
import { validateVairixSheet, VAIRIX_SHEET_MAX_BYTES, extensionOf } from './vairix-sheet';

describe('extensionOf', () => {
  it('returns lowercase extension for common cases', () => {
    expect(extensionOf('sheet.XLSX')).toBe('xlsx');
    expect(extensionOf('a/b/c.csv')).toBe('csv');
  });
  it('returns empty string when there is no extension', () => {
    expect(extensionOf('no-extension')).toBe('');
    expect(extensionOf('.hidden')).toBe('');
    expect(extensionOf('trailing.')).toBe('');
  });
});

describe('validateVairixSheet', () => {
  it('rejects missing file name', () => {
    const r = validateVairixSheet({ fileName: null, sizeBytes: 100 });
    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('no_file');
  });
  it('rejects empty file', () => {
    const r = validateVairixSheet({ fileName: 'a.xlsx', sizeBytes: 0 });
    expect(!r.ok && r.code).toBe('empty_file');
  });
  it('rejects oversize file', () => {
    const r = validateVairixSheet({ fileName: 'a.xlsx', sizeBytes: VAIRIX_SHEET_MAX_BYTES + 1 });
    expect(!r.ok && r.code).toBe('file_too_large');
  });
  it('rejects unsupported extension (docx is not a sheet)', () => {
    const r = validateVairixSheet({ fileName: 'a.docx', sizeBytes: 500 });
    expect(!r.ok && r.code).toBe('unsupported_extension');
  });
  it('accepts xlsx, xls, csv, pdf', () => {
    for (const name of ['a.xlsx', 'a.xls', 'a.csv', 'a.pdf']) {
      const r = validateVairixSheet({ fileName: name, sizeBytes: 100 });
      expect(r.ok).toBe(true);
    }
  });
  it('uppercase extension normalized', () => {
    const r = validateVairixSheet({ fileName: 'A.XLSX', sizeBytes: 100 });
    expect(r.ok && r.ext).toBe('xlsx');
  });
});
