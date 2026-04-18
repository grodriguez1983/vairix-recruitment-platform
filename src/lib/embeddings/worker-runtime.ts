/**
 * Shared runtime for the per-source embeddings workers (F3-001).
 *
 * Every source (profile, notes, cv, evaluation) runs the same loop:
 *
 *   for each page of active candidates:
 *     load the source's content per candidate
 *     load existing embeddings for (candidate_id, source_type, null)
 *     for each candidate:
 *       content = build(...)
 *       if content is null: skipped++, continue
 *       hash = sha256(model + content)
 *       if hash matches prior: reused++, continue
 *       vector = provider.embed([content])
 *       upsert embedding
 *       regenerated++
 *
 * Previously each worker duplicated this ~180-line scaffold. This
 * module hosts it once; per-source files only provide a `SourceHandler`
 * describing how to load/build their content.
 *
 * Pagination: the old workers had a `batchSize=500` that behaved like
 * a hard cap, silently dropping candidate >500. The runtime now
 * paginates via `.range()` until the source is exhausted, so a run
 * always covers the full active candidate set. Keeping `batchSize` as
 * a per-page size preserves the public signature.
 *
 * Logging: emits a single structured line per run and (at INFO) a
 * line per page so long backfills are observable. All messages go to
 * stderr so the CLIs can keep stdout clean for summary output.
 *
 * Service-role caller required: embeddings are cross-tenant
 * infrastructure (ADR-003, embeddings RLS migration).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { contentHash } from './hash';
import type { EmbeddingProvider } from './provider';
import type { EmbeddingSourceType } from '../rag/semantic-search';

export interface RunEmbeddingsOptions {
  /** Restrict the run to these candidate ids (still paginated). */
  candidateIds?: string[];
  /** Rows per page. Defaults to 500. */
  batchSize?: number;
}

export interface EmbeddingsRunResult {
  processed: number;
  skipped: number;
  regenerated: number;
  reused: number;
}

export interface EmbeddingsSourceHandler {
  sourceType: EmbeddingSourceType;
  /**
   * For a given page of candidate ids, return a map `candidateId →
   * content-string-or-null`. Returning null for a candidate marks it
   * as "skip" (no embedding should exist / no regeneration needed).
   */
  buildContents(
    db: SupabaseClient,
    candidateIds: readonly string[],
  ): Promise<Map<string, string | null>>;
}

interface CandidateRow {
  id: string;
}

interface ExistingEmbeddingRow {
  id: string;
  content_hash: string;
}

async function loadCandidatesPage(
  db: SupabaseClient,
  options: RunEmbeddingsOptions,
  from: number,
  to: number,
): Promise<CandidateRow[]> {
  let query = db
    .from('candidates')
    .select('id')
    .is('deleted_at', null)
    .order('id', { ascending: true })
    .range(from, to);
  if (options.candidateIds && options.candidateIds.length > 0) {
    query = query.in('id', options.candidateIds);
  }
  const { data, error } = await query;
  if (error) throw new Error(`failed to load candidates: ${error.message}`);
  return (data ?? []) as CandidateRow[];
}

async function loadExistingHashes(
  db: SupabaseClient,
  sourceType: EmbeddingSourceType,
  candidateIds: readonly string[],
): Promise<Map<string, ExistingEmbeddingRow>> {
  const map = new Map<string, ExistingEmbeddingRow>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('embeddings')
    .select('id, candidate_id, content_hash')
    .eq('source_type', sourceType)
    .is('source_id', null)
    .in('candidate_id', [...candidateIds]);
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
  sourceType: EmbeddingSourceType,
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
    source_type: sourceType,
    source_id: null,
    content: fields.content,
    content_hash: fields.content_hash,
    embedding: fields.embedding,
    model: fields.model,
  });
  if (error) throw new Error(`failed to insert embedding: ${error.message}`);
}

function logLine(obj: Record<string, unknown>): void {
  // Structured log line (JSON) to stderr so CLIs can keep stdout for
  // their own summary. Single line per event to keep log shippers
  // happy.
  const payload = { ts: new Date().toISOString(), ...obj };

  console.error(JSON.stringify(payload));
}

export async function runEmbeddingsWorker(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  handler: EmbeddingsSourceHandler,
  options: RunEmbeddingsOptions = {},
): Promise<EmbeddingsRunResult> {
  const pageSize = options.batchSize ?? 500;
  const totals: EmbeddingsRunResult = {
    processed: 0,
    skipped: 0,
    regenerated: 0,
    reused: 0,
  };

  const startedAt = Date.now();
  let page = 0;
  let offset = 0;

  while (true) {
    const candidates = await loadCandidatesPage(db, options, offset, offset + pageSize - 1);
    if (candidates.length === 0) break;

    const candIds = candidates.map((c) => c.id);
    const [contents, existing] = await Promise.all([
      handler.buildContents(db, candIds),
      loadExistingHashes(db, handler.sourceType, candIds),
    ]);

    for (const c of candidates) {
      const content = contents.get(c.id) ?? null;
      if (content === null || content.length === 0) {
        totals.skipped += 1;
        continue;
      }
      totals.processed += 1;

      const hash = contentHash(provider.model, content);
      const prior = existing.get(c.id);
      if (prior && prior.content_hash === hash) {
        totals.reused += 1;
        continue;
      }

      const [vector] = await provider.embed([content]);
      if (!vector) {
        throw new Error(`provider returned no vector for candidate ${c.id}`);
      }
      if (vector.length !== provider.dim) {
        throw new Error(
          `provider returned vector of length ${vector.length}, expected ${provider.dim}`,
        );
      }

      await upsertEmbedding(db, handler.sourceType, prior, {
        candidate_id: c.id,
        content,
        content_hash: hash,
        embedding: vector,
        model: provider.model,
      });
      totals.regenerated += 1;
    }

    page += 1;
    logLine({
      level: 'info',
      event: 'embed.page',
      source: handler.sourceType,
      page,
      pageSize: candidates.length,
      totals: { ...totals },
    });

    if (candidates.length < pageSize) break;
    offset += candidates.length;
  }

  const durationMs = Date.now() - startedAt;
  const reuseRatio =
    totals.processed === 0 ? 0 : Number((totals.reused / totals.processed).toFixed(3));
  logLine({
    level: 'info',
    event: 'embed.done',
    source: handler.sourceType,
    model: provider.model,
    pages: page,
    durationMs,
    reuseRatio,
    ...totals,
  });

  return totals;
}
