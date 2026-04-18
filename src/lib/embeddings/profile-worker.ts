/**
 * Profile-source embeddings worker (ADR-005, F3-001).
 *
 * Builds a synthetic profile text per candidate (name + headline +
 * summary + tags) and embeds it. One row per candidate
 * (`source_type='profile'`, `source_id=null`). Idempotent via
 * `content_hash`.
 *
 * Delegates the loop, pagination, hash comparison, and upsert to
 * `runEmbeddingsWorker`; this file only wires the source-specific
 * loaders.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import type { EmbeddingProvider } from './provider';
import { buildProfileContent } from './sources/profile';
import {
  runEmbeddingsWorker,
  type EmbeddingsRunResult,
  type EmbeddingsSourceHandler,
  type RunEmbeddingsOptions,
} from './worker-runtime';

export type RunProfileEmbeddingsOptions = RunEmbeddingsOptions;
export type ProfileEmbeddingsResult = EmbeddingsRunResult;

interface CandidateDataRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  pitch: string | null;
}

interface TagRow {
  candidate_id: string;
  tags: { name: string } | null;
}

async function loadCandidateData(
  db: SupabaseClient,
  candidateIds: readonly string[],
): Promise<Map<string, CandidateDataRow>> {
  const map = new Map<string, CandidateDataRow>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('candidates')
    .select('id, first_name, last_name, pitch')
    .in('id', [...candidateIds]);
  if (error) throw new Error(`failed to load candidate profile data: ${error.message}`);
  for (const row of (data ?? []) as CandidateDataRow[]) map.set(row.id, row);
  return map;
}

async function loadTagsByCandidate(
  db: SupabaseClient,
  candidateIds: readonly string[],
): Promise<Map<string, string[]>> {
  const map = new Map<string, string[]>();
  if (candidateIds.length === 0) return map;
  const { data, error } = await db
    .from('candidate_tags')
    .select('candidate_id, tags(name)')
    .in('candidate_id', [...candidateIds]);
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

export const profileSourceHandler: EmbeddingsSourceHandler = {
  sourceType: 'profile',
  async buildContents(db, candidateIds) {
    const [candidates, tags] = await Promise.all([
      loadCandidateData(db, candidateIds),
      loadTagsByCandidate(db, candidateIds),
    ]);
    const out = new Map<string, string | null>();
    for (const id of candidateIds) {
      const c = candidates.get(id);
      if (!c) {
        out.set(id, null);
        continue;
      }
      const content = buildProfileContent({
        candidateId: c.id,
        firstName: c.first_name,
        lastName: c.last_name,
        headline: null,
        summary: c.pitch,
        tags: tags.get(c.id) ?? [],
      });
      out.set(id, content);
    }
    return out;
  },
};

export async function runProfileEmbeddings(
  db: SupabaseClient,
  provider: EmbeddingProvider,
  options: RunProfileEmbeddingsOptions = {},
): Promise<ProfileEmbeddingsResult> {
  return runEmbeddingsWorker(db, provider, profileSourceHandler, options);
}
