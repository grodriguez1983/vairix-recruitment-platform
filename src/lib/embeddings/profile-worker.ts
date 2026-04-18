/**
 * Profile-source embeddings worker (ADR-005, F3-001).
 *
 * For every active candidate in scope:
 *   1. Load identity fields + their tag names.
 *   2. Build the synthetic profile text via `buildProfileContent`.
 *      If it returns null (nothing usable), the candidate is skipped.
 *   3. Compute `contentHash(provider.model, content)`.
 *   4. If an `embeddings` row already exists for
 *      `(candidate_id, 'profile', source_id=null)` with the same
 *      hash, reuse it (no provider call, no write).
 *   5. Otherwise call `provider.embed([content])` and upsert.
 *
 * The worker is batched: it calls the provider once per candidate
 * that actually needs regeneration. For profile text this is fine
 * (short strings, few calls); CV chunks will want bulk batching.
 *
 * Upsert uses the unique index `(candidate_id, source_type, source_id)`.
 * Because `source_id` can be null and Postgres unique indexes treat
 * nulls as distinct by default, we handle the null-source-id case
 * with a read-then-insert-or-update rather than trusting `onConflict`.
 *
 * Service-role caller required: embeddings are cross-tenant
 * infrastructure (see ADR-003 + embeddings RLS migration).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { contentHash } from './hash';
import type { EmbeddingProvider } from './provider';
import { buildProfileContent, type ProfileSourceInput } from './sources/profile';

export interface RunProfileEmbeddingsOptions {
  candidateIds?: string[];
  batchSize?: number;
}

export interface ProfileEmbeddingsResult {
  processed: number;
  skipped: number;
  regenerated: number;
  reused: number;
}

interface CandidateRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  pitch: string | null;
}

interface TagRow {
  candidate_id: string;
  tags: { name: string } | null;
}

async function loadCandidates(
  db: SupabaseClient,
  options: RunProfileEmbeddingsOptions,
): Promise<CandidateRow[]> {
  const { candidateIds, batchSize = 500 } = options;
  let query = db
    .from('candidates')
    .select('id, first_name, last_name, pitch')
    .is('deleted_at', null)
    .limit(batchSize);
  if (candidateIds && candidateIds.length > 0) {
    query = query.in('id', candidateIds);
  }
  const { data, error } = await query;
  if (error) throw new Error(`failed to load candidates: ${error.message}`);
  return (data ?? []) as CandidateRow[];
}

async function loadTagsByCandidate(
  db: SupabaseClient,
  candidateIds: string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('candidate_tags')
    .select('candidate_id, tags(name)')
    .in('candidate_id', candidateIds);
  if (error) throw new Error(`failed to load candidate tags: ${error.message}`);
  for (const row of (data ?? []) as unknown as TagRow[]) {
    const name = row.tags?.name;
    if (!name) continue;
    const arr = map.get(row.candidate_id) ?? [];
    arr.push(name);
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
    .eq('source_type', 'profile')
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
    source_type: 'profile',
    source_id: null,
    content: fields.content,
    content_hash: fields.content_hash,
    embedding: fields.embedding,
    model: fields.model,
  });
  if (error) throw new Error(`failed to insert embedding: ${error.message}`);
}

export async function runProfileEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunProfileEmbeddingsOptions = {},
): Promise<ProfileEmbeddingsResult> {
  const candidates = await loadCandidates(db, options);
  const candIds = candidates.map((c) => c.id);
  const [tagsByCandidate, existing] = await Promise.all([
    loadTagsByCandidate(db, candIds),
    loadExistingHashes(db, candIds),
  ]);

  let processed = 0;
  let skipped = 0;
  let regenerated = 0;
  let reused = 0;

  for (const c of candidates) {
    const input: ProfileSourceInput = {
      candidateId: c.id,
      firstName: c.first_name,
      lastName: c.last_name,
      headline: null,
      summary: c.pitch,
      tags: tagsByCandidate.get(c.id) ?? [],
    };
    const content = buildProfileContent(input);
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
