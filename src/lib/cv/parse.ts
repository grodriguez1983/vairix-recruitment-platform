/**
 * CV parser dispatcher.
 *
 * Routes a binary buffer to the right parser based on `fileType`,
 * normalizes the extracted text, and classifies failure modes with
 * stable error codes (ADR-006 §4).
 *
 * Parsers are injected (`CvParserDeps`) so the dispatcher can be
 * tested without real PDF/DOCX fixtures and so the worker can wire
 * real implementations at the edge of the system.
 *
 * Error classification:
 *   - `unsupported_format` — file_type not in {pdf, docx, txt}.
 *   - `parse_failure`      — parser threw.
 *   - `empty_text`         — post-normalize text length == 0.
 *   - `likely_scanned`     — PDF with < 200 chars of useful text
 *                            (heuristic; OCR out of scope in Fase 1).
 */
export type CvParseErrorCode =
  | 'unsupported_format'
  | 'parse_failure'
  | 'empty_text'
  | 'likely_scanned';

export type ParseResult =
  | { status: 'ok'; text: string }
  | { status: 'error'; code: CvParseErrorCode };

export interface CvParserDeps {
  parsePdf: (buf: Buffer) => Promise<{ text: string }>;
  parseDocx: (buf: Buffer) => Promise<{ value: string }>;
}

/**
 * Default deps that wire real pdf-parse / mammoth. Imported lazily
 * so unit tests can run without loading native/heavy modules.
 */
async function loadDefaultDeps(): Promise<CvParserDeps> {
  const [pdfParseMod, mammothMod] = await Promise.all([import('pdf-parse'), import('mammoth')]);
  const pdfParse = (pdfParseMod as { default: (buf: Buffer) => Promise<{ text: string }> }).default;
  const mammoth = mammothMod as {
    extractRawText: (args: { buffer: Buffer }) => Promise<{ value: string }>;
  };
  return {
    parsePdf: (buf) => pdfParse(buf),
    parseDocx: (buf) => mammoth.extractRawText({ buffer: buf }),
  };
}

const SCANNED_MIN_CHARS = 200;

export function normalize(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

export async function parseCvBuffer(
  fileType: string,
  buffer: Buffer,
  depsOverride?: CvParserDeps,
): Promise<ParseResult> {
  const type = fileType.toLowerCase();
  if (type !== 'pdf' && type !== 'docx' && type !== 'txt') {
    return { status: 'error', code: 'unsupported_format' };
  }

  let raw: string;
  try {
    if (type === 'txt') {
      raw = buffer.toString('utf8');
    } else {
      const deps = depsOverride ?? (await loadDefaultDeps());
      if (type === 'pdf') {
        const parsed = await deps.parsePdf(buffer);
        raw = parsed.text;
      } else {
        const parsed = await deps.parseDocx(buffer);
        raw = parsed.value;
      }
    }
  } catch {
    return { status: 'error', code: 'parse_failure' };
  }

  const text = normalize(raw);

  // PDF-specific heuristic for scanned docs. Tiny text → assume image.
  if (type === 'pdf' && text.length < SCANNED_MIN_CHARS) {
    return { status: 'error', code: 'likely_scanned' };
  }
  if (text.length === 0) {
    return { status: 'error', code: 'empty_text' };
  }
  return { status: 'ok', text };
}
