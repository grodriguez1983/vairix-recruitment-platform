/**
 * CV source builder for the embeddings pipeline (ADR-005 §Fuentes a
 * embeber, F3-001).
 *
 * Picks the most recently parsed CV for a candidate and returns its
 * text (whitespace-collapsed, truncated to a safe ceiling). One
 * embedding per candidate — older CVs are ignored once a newer one
 * is parsed.
 *
 * Truncation: per ADR-005 §Chunking, Fase 1 trunca al primer chunk
 * si el CV excede el límite del modelo (8192 tokens ≈ ~32k chars
 * con el modelo de OpenAI). Elegimos 30000 chars para tener margen.
 *
 * Determinism: hash drives cache invalidation. Identical sets of
 * files in any order must yield the same string. We tie-break by
 * file id when parsed_at is missing.
 */
export interface CvFileInput {
  id: string;
  parsedText: string | null;
  parsedAt: string | Date | null;
  deletedAt: string | Date | null;
}

export interface CvSourceInput {
  candidateId: string;
  files: readonly CvFileInput[];
}

export const CV_CONTENT_MAX_CHARS = 30000;

function toTimestamp(v: string | Date | null): number | null {
  if (v === null) return null;
  if (v instanceof Date) return v.getTime();
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanText(v: string | null): string {
  if (v === null) return '';
  return v.replace(/\s+/g, ' ').trim();
}

function pickLatest(files: readonly CvFileInput[]): CvFileInput | null {
  const eligible = files.filter((f) => {
    if (f.deletedAt !== null) return false;
    return cleanText(f.parsedText).length > 0;
  });
  if (eligible.length === 0) return null;

  // Sort DESC by parsed_at (null treated as -Infinity so anything
  // with a timestamp wins), then ASC by id for stability.
  const sorted = [...eligible].sort((a, b) => {
    const ta = toTimestamp(a.parsedAt);
    const tb = toTimestamp(b.parsedAt);
    if (ta !== null && tb !== null && ta !== tb) return tb - ta;
    if (ta !== null && tb === null) return -1;
    if (ta === null && tb !== null) return 1;
    return a.id.localeCompare(b.id, 'en');
  });
  return sorted[0] ?? null;
}

export function buildCvContent(input: CvSourceInput): string | null {
  const latest = pickLatest(input.files);
  if (!latest) return null;
  const text = cleanText(latest.parsedText);
  if (text.length === 0) return null;
  if (text.length <= CV_CONTENT_MAX_CHARS) return text;
  return text.slice(0, CV_CONTENT_MAX_CHARS);
}
