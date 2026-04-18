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

// RED stub — real implementation lands in the GREEN commit.
export function buildNotesContent(_input: NotesSourceInput): string | null {
  throw new Error('not implemented');
}
