/**
 * CV-source embeddings worker (ADR-005, F3-001).
 *
 * One embedding per candidate (`source_type='cv'`, `source_id=null`)
 * built from the most recent parsed CV in `files.parsed_text`. Older
 * CVs are ignored; soft-deleted files are ignored. Regeneration is
 * driven by `content_hash` (salted with provider.model).
 *
 * Mirrors the notes-worker pattern — load candidates, load their
 * files (filtered to those with parsed_text), load existing cv
 * embeddings, compare hashes, reuse or regenerate.
 *
 * Service-role caller required (embeddings are cross-tenant infra).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { contentHash } from './hash';
import type { EmbeddingProvider } from './provider';
import { buildCvContent, type CvFileInput } from './sources/cv';

export interface RunCvEmbeddingsOptions {
  candidateIds?: string[];
  batchSize?: number;
}

export interface CvEmbeddingsResult {
  processed: number;
  skipped: number;
  regenerated: number;
  reused: number;
}

interface CandidateRow {
  id: string;
}

interface FileRow {
  id: string;
  candidate_id: string;
  parsed_text: string | null;
  parsed_at: string | null;
  deleted_at: string | null;
}

async function loadCandidates(
  db: SupabaseClient,
  options: RunCvEmbeddingsOptions,
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

async function loadFilesByCandidate(
  db: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, CvFileInput[]>> {
  const map = new Map<string, CvFileInput[]>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('files')
    .select('id, candidate_id, parsed_text, parsed_at, deleted_at')
    .is('deleted_at', null)
    .in('candidate_id', candidateIds);
  if (error) throw new Error(`failed to load files: ${error.message}`);
  for (const row of (data ?? []) as FileRow[]) {
    const arr = map.get(row.candidate_id) ?? [];
    arr.push({
      id: row.id,
      parsedText: row.parsed_text,
      parsedAt: row.parsed_at,
      deletedAt: row.deleted_at,
    });
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
    .eq('source_type', 'cv')
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
    source_type: 'cv',
    source_id: null,
    content: fields.content,
    content_hash: fields.content_hash,
    embedding: fields.embedding,
    model: fields.model,
  });
  if (error) throw new Error(`failed to insert embedding: ${error.message}`);
}

export async function runCvEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunCvEmbeddingsOptions = {},
): Promise<CvEmbeddingsResult> {
  const candidates = await loadCandidates(db, options);
  const candIds = candidates.map((c) => c.id);
  const [filesByCandidate, existing] = await Promise.all([
    loadFilesByCandidate(db, candIds),
    loadExistingHashes(db, candIds),
  ]);

  let processed = 0;
  let skipped = 0;
  let regenerated = 0;
  let reused = 0;

  for (const c of candidates) {
    const content = buildCvContent({
      candidateId: c.id,
      files: filesByCandidate.get(c.id) ?? [],
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
