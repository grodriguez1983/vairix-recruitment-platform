/**
 * Notes-source embeddings worker (ADR-005, F3-001).
 *
 * Aggregates a candidate's notes into a single embedding input. One
 * row per candidate (`source_type='notes'`, `source_id=null`).
 * Idempotent via `content_hash`; regenerates when a note is added,
 * edited, or soft-deleted, and when the provider model changes.
 *
 * Delegates the loop, pagination, hash comparison, and upsert to
 * `runEmbeddingsWorker`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from './provider';
import { buildNotesContent, type NoteInput } from './sources/notes';
import {
  runEmbeddingsWorker,
  type EmbeddingsRunResult,
  type EmbeddingsSourceHandler,
  type RunEmbeddingsOptions,
} from './worker-runtime';

export type RunNotesEmbeddingsOptions = RunEmbeddingsOptions;
export type NotesEmbeddingsResult = EmbeddingsRunResult;

interface NoteRow {
  candidate_id: string;
  body: string | null;
  created_at: string | null;
}

async function loadNotesByCandidate(
  db: SupabaseClient,
  candidateIds: readonly string[],
): Promise<Map<string, NoteInput[]>> {
  const map = new Map<string, NoteInput[]>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('notes')
    .select('candidate_id, body, created_at')
    .is('deleted_at', null)
    .in('candidate_id', [...candidateIds]);
  if (error) throw new Error(`failed to load notes: ${error.message}`);
  for (const row of (data ?? []) as NoteRow[]) {
    const arr = map.get(row.candidate_id) ?? [];
    arr.push({ body: row.body, createdAt: row.created_at });
    map.set(row.candidate_id, arr);
  }
  return map;
}

export const notesSourceHandler: EmbeddingsSourceHandler = {
  sourceType: 'notes',
  async buildContents(db, candidateIds) {
    const notesByCandidate = await loadNotesByCandidate(db, candidateIds);
    const out = new Map<string, string | null>();
    for (const id of candidateIds) {
      out.set(
        id,
        buildNotesContent({
          candidateId: id,
          notes: notesByCandidate.get(id) ?? [],
        }),
      );
    }
    return out;
  },
};

export async function runNotesEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunNotesEmbeddingsOptions = {},
): Promise<NotesEmbeddingsResult> {
  return runEmbeddingsWorker(db, provider, notesSourceHandler, options);
}
