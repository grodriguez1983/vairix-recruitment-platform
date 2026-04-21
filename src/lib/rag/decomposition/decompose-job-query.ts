/**
 * `decomposeJobQuery` — orchestrator for the job-description
 * decomposition pipeline (ADR-014 §5).
 *
 * All I/O is injected so the service is unit-testable without a
 * Supabase connection. The orchestrator:
 *
 *   1. Preprocesses raw_text.
 *   2. Computes content_hash over normalized text + model + prompt
 *      version.
 *   3. Looks up an existing `job_queries` row by hash.
 *        - On hit: re-resolves decomposed_json against the current
 *          catalog; if unresolved_skills drifted from the stored
 *          set, updates resolved_json + unresolved_skills.
 *        - On miss: calls provider.decompose, validates the
 *          evidence_snippet contract, resolves skills, inserts the
 *          row.
 *   4. Returns { query_id, cached, resolved, unresolved_skills }.
 *
 * All failure modes raise `DecompositionError` with a discriminant
 * `code` (ADR-014 §6) so API routes can map to HTTP status without
 * string-matching messages.
 */
import type { CatalogSnapshot } from '../../skills/resolver';

import type { DecompositionProvider } from './provider';
import type { ResolvedDecomposition } from './resolve-requirements';
import type { DecompositionResult } from './types';

export interface JobQueryInsertRow {
  content_hash: string;
  raw_text: string;
  model: string;
  prompt_version: string;
  decomposed_json: DecompositionResult;
  resolved_json: ResolvedDecomposition;
  unresolved_skills: string[];
  created_by: string;
  tenant_id: string | null;
}

export interface JobQueryCachedRow {
  id: string;
  content_hash: string;
  decomposed_json: DecompositionResult;
  unresolved_skills: string[];
}

export interface DecomposeJobQueryDeps {
  provider: DecompositionProvider;
  loadCatalog: () => Promise<CatalogSnapshot>;
  findByHash: (hash: string) => Promise<JobQueryCachedRow | null>;
  insertJobQuery: (row: JobQueryInsertRow) => Promise<{ id: string }>;
  updateResolved: (
    id: string,
    resolvedJson: ResolvedDecomposition,
    unresolvedSkills: string[],
  ) => Promise<void>;
  createdBy: string;
  tenantId: string | null;
  now?: () => Date;
}

export interface DecomposeJobQueryResult {
  query_id: string;
  cached: boolean;
  resolved: ResolvedDecomposition;
  unresolved_skills: string[];
}

// RED stub.
export async function decomposeJobQuery(
  _rawText: string,
  _deps: DecomposeJobQueryDeps,
): Promise<DecomposeJobQueryResult> {
  throw new Error('decomposeJobQuery: not implemented');
}
