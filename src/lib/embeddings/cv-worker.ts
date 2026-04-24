/**
 * CV-source embeddings worker (ADR-005, F3-001).
 *
 * Embeds the most recent parsed CV per candidate. One row per
 * candidate (`source_type='cv'`, `source_id=null`). Soft-deleted
 * files are ignored. Idempotent via `content_hash`.
 *
 * Delegates the loop, pagination, hash comparison, and upsert to
 * `runEmbeddingsWorker`.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { IN_QUERY_CHUNK_SIZE, runChunked } from '../shared/chunked-in';
import type { EmbeddingProvider } from './provider';
import { buildCvContent, type CvFileInput } from './sources/cv';
import {
  runEmbeddingsWorker,
  type EmbeddingsRunResult,
  type EmbeddingsSourceHandler,
  type RunEmbeddingsOptions,
} from './worker-runtime';

export type RunCvEmbeddingsOptions = RunEmbeddingsOptions;
export type CvEmbeddingsResult = EmbeddingsRunResult;

interface FileRow {
  id: string;
  candidate_id: string;
  parsed_text: string | null;
  parsed_at: string | null;
  deleted_at: string | null;
}

async function loadFilesByCandidate(
  db: SupabaseClient,
  candidateIds: readonly string[],
): Promise<Map<string, CvFileInput[]>> {
  const map = new Map<string, CvFileInput[]>();
  const rows = await runChunked<FileRow>(candidateIds, IN_QUERY_CHUNK_SIZE, async (chunk) => {
    const { data, error } = await db
      .from('files')
      .select('id, candidate_id, parsed_text, parsed_at, deleted_at')
      .is('deleted_at', null)
      .in('candidate_id', chunk);
    if (error) throw new Error(`failed to load files: ${error.message}`);
    return (data ?? []) as FileRow[];
  });
  for (const row of rows) {
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

export const cvSourceHandler: EmbeddingsSourceHandler = {
  sourceType: 'cv',
  async buildContents(db, candidateIds) {
    const filesByCandidate = await loadFilesByCandidate(db, candidateIds);
    const out = new Map<string, string | null>();
    for (const id of candidateIds) {
      out.set(
        id,
        buildCvContent({
          candidateId: id,
          files: filesByCandidate.get(id) ?? [],
        }),
      );
    }
    return out;
  },
};

export async function runCvEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunCvEmbeddingsOptions = {},
): Promise<CvEmbeddingsResult> {
  return runEmbeddingsWorker(db, provider, cvSourceHandler, options);
}
