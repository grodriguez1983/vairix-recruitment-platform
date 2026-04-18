/**
 * Notes-source embeddings worker (ADR-005, F3-001).
 *
 * Mirror of the profile worker, but the source content is the
 * chronological concatenation of a candidate's notes bodies. One
 * embedding row per candidate (`source_type='notes'`, `source_id=null`),
 * not one per note — this keeps the retrieval surface compact and
 * matches ADR-005 §Fuentes a embeber.
 *
 * Regeneration is still driven by `content_hash`, which depends on
 * provider.model + the final concatenated string. Adding a note,
 * editing one, or soft-deleting one all change the string and
 * therefore the hash.
 *
 * Service-role caller required (embeddings are cross-tenant infra
 * per ADR-003 and the embeddings RLS migration).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { contentHash } from './hash';
import type { EmbeddingProvider } from './provider';
import { buildNotesContent, type NoteInput } from './sources/notes';

export interface RunNotesEmbeddingsOptions {
  candidateIds?: string[];
  batchSize?: number;
}

export interface NotesEmbeddingsResult {
  processed: number;
  skipped: number;
  regenerated: number;
  reused: number;
}

interface CandidateRow {
  id: string;
}

interface NoteRow {
  candidate_id: string;
  body: string | null;
  created_at: string | null;
}

async function loadCandidates(
  db: SupabaseClient,
  options: RunNotesEmbeddingsOptions,
): Promise<CandidateRow[]> {
  const { candidateIds, batchSize = 500 } = options;
  let query = db.from('candidates').select('id').is('deleted_at', null).limit(batchSize);
  if (candidateIds && candidateIds.length > 0) {
    query = query.in('id', candidateIds);
  }
  const { data, error } = await query;
  if (error) throw new Error(`failed to load candidates: ${error.message}`);
  return (data ?? []) as CandidateRow[];
}

async function loadNotesByCandidate(
  db: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, NoteInput[]>> {
  const map = new Map<string, NoteInput[]>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('notes')
    .select('candidate_id, body, created_at')
    .is('deleted_at', null)
    .in('candidate_id', candidateIds);
  if (error) throw new Error(`failed to load notes: ${error.message}`);
  for (const row of (data ?? []) as NoteRow[]) {
    const arr = map.get(row.candidate_id) ?? [];
    arr.push({ body: row.body, createdAt: row.created_at });
    map.set(row.candidate_id, arr);
  }
  return map;
}

interface ExistingEmbeddingRow {
  id: string;
  content_hash: string;
}

async function loadExistingHashes(
  db: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, ExistingEmbeddingRow>> {
  const map = new Map<string, ExistingEmbeddingRow>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('embeddings')
    .select('id, candidate_id, content_hash')
    .eq('source_type', 'notes')
    .is('source_id', null)
    .in('candidate_id', candidateIds);
  if (error) throw new Error(`failed to load existing embeddings: ${error.message}`);
  for (const row of data ?? []) {
    map.set(row.candidate_id as string, {
      id: row.id as string,
      content_hash: row.content_hash as string,
    });
  }
  return map;
}

async function upsertEmbedding(
  db: SupabaseClient,
  existing: ExistingEmbeddingRow | undefined,
  fields: {
    candidate_id: string;
    content: string;
    content_hash: string;
    embedding: number[];
    model: string;
  },
): Promise<void> {
  if (existing) {
    const { error } = await db
      .from('embeddings')
      .update({
        content: fields.content,
        content_hash: fields.content_hash,
        embedding: fields.embedding,
        model: fields.model,
      })
      .eq('id', existing.id);
    if (error) throw new Error(`failed to update embedding: ${error.message}`);
    return;
  }
  const { error } = await db.from('embeddings').insert({
    candidate_id: fields.candidate_id,
    source_type: 'notes',
    source_id: null,
    content: fields.content,
    content_hash: fields.content_hash,
    embedding: fields.embedding,
    model: fields.model,
  });
  if (error) throw new Error(`failed to insert embedding: ${error.message}`);
}

export async function runNotesEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunNotesEmbeddingsOptions = {},
): Promise<NotesEmbeddingsResult> {
  const candidates = await loadCandidates(db, options);
  const candIds = candidates.map((c) => c.id);
  const [notesByCandidate, existing] = await Promise.all([
    loadNotesByCandidate(db, candIds),
    loadExistingHashes(db, candIds),
  ]);

  let processed = 0;
  let skipped = 0;
  let regenerated = 0;
  let reused = 0;

  for (const c of candidates) {
    const content = buildNotesContent({
      candidateId: c.id,
      notes: notesByCandidate.get(c.id) ?? [],
    });
    if (content === null) {
      skipped += 1;
      continue;
    }
    processed += 1;

    const hash = contentHash(provider.model, content);
    const prior = existing.get(c.id);
    if (prior && prior.content_hash === hash) {
      reused += 1;
      continue;
    }

    const [vector] = await provider.embed([content]);
    if (!vector) throw new Error(`provider returned no vector for candidate ${c.id}`);
    if (vector.length !== provider.dim) {
      throw new Error(
        `provider returned vector of length ${vector.length}, expected ${provider.dim}`,
      );
    }

    await upsertEmbedding(db, prior, {
      candidate_id: c.id,
      content,
      content_hash: hash,
      embedding: vector,
      model: provider.model,
    });
    regenerated += 1;
  }

  return { processed, skipped, regenerated, reused };
}
