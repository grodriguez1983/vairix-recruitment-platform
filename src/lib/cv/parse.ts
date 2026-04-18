/**
 * CV parser — [RED] stub. Real implementation in paired [GREEN] commit.
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

export function normalize(_raw: string): string {
  throw new Error('normalize not implemented');
}

export async function parseCvBuffer(
  _fileType: string,
  _buffer: Buffer,
  _deps?: CvParserDeps,
): Promise<ParseResult> {
  throw new Error('parseCvBuffer not implemented');
}
