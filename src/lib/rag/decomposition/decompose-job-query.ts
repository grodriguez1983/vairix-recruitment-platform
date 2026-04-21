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

import { DecompositionError } from './errors';
import { decompositionContentHash } from './hash';
import { preprocess } from './preprocess';
import type { DecompositionProvider } from './provider';
import { resolveRequirements, type ResolvedDecomposition } from './resolve-requirements';
import type { DecompositionResult } from './types';

export interface JobQueryInsertRow {
  content_hash: string;
  raw_text: string;
  normalized_text: string;
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

/**
 * ZodError detection without importing zod here — the service must
 * not couple to the provider's validation library. Any error whose
 * `name` is 'ZodError' is a schema-shape failure (our two providers
 * both rely on Zod).
 */
function isZodError(e: unknown): boolean {
  return e instanceof Error && e.name === 'ZodError';
}

/**
 * Verifies ADR-014 §3 rule 3: evidence_snippet must be a literal
 * substring of the preprocessed raw_text. A mismatch means the LLM
 * paraphrased or fabricated the evidence — we refuse to persist the
 * row.
 */
function assertLiteralSnippets(decomposed: DecompositionResult, normalized: string): void {
  for (const req of decomposed.requirements) {
    if (!normalized.includes(req.evidence_snippet)) {
      throw new DecompositionError(
        'hallucinated_snippet',
        `evidence_snippet for ${req.skill_raw} is not a literal substring of raw_text`,
      );
    }
  }
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  for (let i = 0; i < sa.length; i += 1) {
    if (sa[i] !== sb[i]) return false;
  }
  return true;
}

export async function decomposeJobQuery(
  rawText: string,
  deps: DecomposeJobQueryDeps,
): Promise<DecomposeJobQueryResult> {
  const normalized = preprocess(rawText);
  if (normalized.length === 0) {
    throw new DecompositionError('empty_input', 'raw_text is empty after preprocess');
  }

  const { model, promptVersion } = deps.provider;
  const hash = decompositionContentHash(normalized, model, promptVersion);

  const cached = await deps.findByHash(hash);
  const catalog = await deps.loadCatalog();
  const now = deps.now;

  if (cached !== null) {
    const { resolved, unresolved_skills } = resolveRequirements(
      cached.decomposed_json,
      catalog,
      now === undefined ? {} : { now },
    );
    if (!sameSet(cached.unresolved_skills, unresolved_skills)) {
      await deps.updateResolved(cached.id, resolved, unresolved_skills);
    }
    return { query_id: cached.id, cached: true, resolved, unresolved_skills };
  }

  let decomposed: DecompositionResult;
  try {
    decomposed = await deps.provider.decompose(rawText);
  } catch (e) {
    if (isZodError(e)) {
      throw new DecompositionError(
        'schema_violation',
        e instanceof Error ? e.message : 'schema violation',
        { cause: e },
      );
    }
    throw new DecompositionError('provider_failure', e instanceof Error ? e.message : String(e), {
      cause: e,
    });
  }

  assertLiteralSnippets(decomposed, normalized);

  const { resolved, unresolved_skills } = resolveRequirements(
    decomposed,
    catalog,
    now === undefined ? {} : { now },
  );

  const inserted = await deps.insertJobQuery({
    content_hash: hash,
    raw_text: rawText,
    normalized_text: normalized,
    model,
    prompt_version: promptVersion,
    decomposed_json: decomposed,
    resolved_json: resolved,
    unresolved_skills,
    created_by: deps.createdBy,
    tenant_id: deps.tenantId,
  });

  return { query_id: inserted.id, cached: false, resolved, unresolved_skills };
}
