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

export function buildCvContent(_input: CvSourceInput): string | null {
  throw new Error('buildCvContent: not implemented');
}
