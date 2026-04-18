/**
 * Notes source builder for the embeddings pipeline (ADR-005
 * §Fuentes a embeber).
 *
 * Aggregates a candidate's free-form notes into a single embedding
 * input: one `notes` embedding per candidate (source_id null),
 * mirroring the profile source.
 *
 * Per ADR-005: "Concatenación de `notes.body` del candidate". Notes
 * are sorted chronologically (oldest first) so that earlier
 * observations set context for later ones. Empty bodies are dropped
 * silently; if nothing remains we return null so the worker skips.
 *
 * Determinism: the hash is what drives cache invalidation. We
 * normalize whitespace and sort by timestamp so identical inputs
 * always produce identical strings.
 */
export interface NoteInput {
  body: string | null;
  createdAt: string | Date | null;
}

export interface NotesSourceInput {
  candidateId: string;
  notes: readonly NoteInput[];
}

function toTimestamp(v: string | Date | null): number {
  if (v === null) return 0;
  if (v instanceof Date) return v.getTime();
  const parsed = Date.parse(v);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cleanBody(body: string | null): string {
  if (body === null) return '';
  return body.replace(/\s+/g, ' ').trim();
}

export function buildNotesContent(input: NotesSourceInput): string | null {
  const sorted = [...input.notes].sort(
    (a, b) => toTimestamp(a.createdAt) - toTimestamp(b.createdAt),
  );
  const bodies: string[] = [];
  for (const n of sorted) {
    const body = cleanBody(n.body);
    if (body.length === 0) continue;
    bodies.push(body);
  }
  if (bodies.length === 0) return null;
  return bodies.join('\n\n');
}
