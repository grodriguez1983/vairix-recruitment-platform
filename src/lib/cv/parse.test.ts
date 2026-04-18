/**
 * Unit tests for CV parser dispatcher.
 *
 * Parsers (pdf-parse, mammoth) are injected so tests don't need
 * actual PDF/DOCX binaries. The dispatcher logic — file type
 * routing, scanned detection, error classification, text
 * normalization — is what matters and is covered here.
 */
import { describe, expect, it, vi } from 'vitest';

import { parseCvBuffer, normalize, type CvParserDeps } from './parse';

function deps(overrides: Partial<CvParserDeps> = {}): CvParserDeps {
  return {
    parsePdf: vi.fn().mockResolvedValue({ text: '' }),
    parseDocx: vi.fn().mockResolvedValue({ value: '' }),
    ...overrides,
  };
}

describe('normalize', () => {
  it('collapses \\r\\n to \\n', () => {
    expect(normalize('a\r\nb\r\nc')).toBe('a\nb\nc');
  });
  it('collapses 3+ consecutive newlines to 2', () => {
    expect(normalize('a\n\n\n\nb')).toBe('a\n\nb');
  });
  it('collapses tabs/spaces to single space', () => {
    expect(normalize('a   \t\t  b')).toBe('a b');
  });
  it('trims leading/trailing whitespace', () => {
    expect(normalize('  hello  ')).toBe('hello');
  });
});

describe('parseCvBuffer', () => {
  it('returns ok with normalized text for a valid pdf', async () => {
    const d = deps({
      parsePdf: vi.fn().mockResolvedValue({
        text:
          'John Doe\r\n\r\n\r\nSenior Engineer with   10 years of experience. ' + 'x'.repeat(300),
      }),
    });
    const result = await parseCvBuffer('pdf', Buffer.from('fake'), d);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toContain('John Doe');
    expect(result.text).not.toContain('\r\n');
    expect(result.text).not.toMatch(/\n{3,}/);
  });

  it('detects likely_scanned for pdf with < 200 chars of useful text', async () => {
    const d = deps({
      parsePdf: vi.fn().mockResolvedValue({ text: 'only a tiny bit of text' }),
    });
    const result = await parseCvBuffer('pdf', Buffer.from('fake'), d);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.code).toBe('likely_scanned');
  });

  it('returns empty_text when parsed output is blank (all whitespace)', async () => {
    const d = deps({
      parseDocx: vi.fn().mockResolvedValue({ value: '   \n\n\t  ' }),
    });
    const result = await parseCvBuffer('docx', Buffer.from('fake'), d);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.code).toBe('empty_text');
  });

  it('parses docx successfully', async () => {
    const d = deps({
      parseDocx: vi
        .fn()
        .mockResolvedValue({ value: 'Name: Ada Lovelace\n\nSkills: Postgres, TypeScript' }),
    });
    const result = await parseCvBuffer('docx', Buffer.from('fake'), d);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toContain('Ada Lovelace');
  });

  it('parses txt without calling pdf or docx parsers', async () => {
    const d = deps();
    const buf = Buffer.from('Plain text CV\nwith two lines', 'utf8');
    const result = await parseCvBuffer('txt', buf, d);
    expect(result.status).toBe('ok');
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.text).toBe('Plain text CV\nwith two lines');
    expect(d.parsePdf).not.toHaveBeenCalled();
    expect(d.parseDocx).not.toHaveBeenCalled();
  });

  it('returns unsupported_format for rtf / doc / anything else', async () => {
    for (const t of ['rtf', 'doc', 'odt', 'zip', '']) {
      const result = await parseCvBuffer(t, Buffer.from('x'), deps());
      expect(result.status).toBe('error');
      if (result.status !== 'error') throw new Error('expected error');
      expect(result.code).toBe('unsupported_format');
    }
  });

  it('returns parse_failure when underlying parser throws', async () => {
    const d = deps({
      parsePdf: vi.fn().mockRejectedValue(new Error('boom')),
    });
    const result = await parseCvBuffer('pdf', Buffer.from('fake'), d);
    expect(result.status).toBe('error');
    if (result.status !== 'error') throw new Error('expected error');
    expect(result.code).toBe('parse_failure');
  });

  it('is case-insensitive on file_type', async () => {
    const d = deps({
      parsePdf: vi.fn().mockResolvedValue({ text: 'x'.repeat(250) }),
    });
    const result = await parseCvBuffer('PDF', Buffer.from('fake'), d);
    expect(result.status).toBe('ok');
  });
});
