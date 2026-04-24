/**
 * CLI: extract structured data from parsed CVs (ADR-012 §6).
 *
 * Reads `files` rows that have `parsed_text` set and do NOT yet have
 * a `candidate_extractions` row for the current `(model,
 * prompt_version)`. For each, classifies variant, calls the LLM
 * provider, and persists the raw JSON output.
 *
 * Idempotency: `candidate_extractions.content_hash` is UNIQUE, and
 * the pending query filters out files already extracted for the
 * running (model, prompt_version). Running the CLI twice back-to-back
 * is a no-op.
 *
 * Re-extract policy (ADR-012 §5): bumping `OPENAI_EXTRACTION_MODEL`
 * or `EXTRACTION_PROMPT_V1` invalidates every hash. A typo fix in the
 * prompt body that does not bump the version is intentionally
 * outside the hash domain.
 *
 * Service-role access is required (cross-tenant ETL job, ADR-003).
 *
 * Required env vars:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - OPENAI_API_KEY
 * Optional:
 *   - OPENAI_EXTRACTION_MODEL (default: gpt-4o-mini)
 *   - EXTRACT_BATCH_SIZE (default: 50)
 *
 * Flags:
 *   --batch=N  override EXTRACT_BATCH_SIZE for one run
 *
 * Exit codes:
 *   0 — success (including zero pending rows)
 *   2 — configuration error (missing env var)
 *   4 — fatal error during run
 */
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import { listPendingExtractions } from '../lib/cv/extraction/list-pending';
import { createOpenAiExtractionProvider } from '../lib/cv/extraction/providers/openai-extractor';
import { runCvExtractions, type CvExtractionWorkerDeps } from '../lib/cv/extraction/worker';
import type { ExtractionProvider } from '../lib/cv/extraction/provider';
import {
  deriveExperiences,
  type DeriveExperiencesDeps,
} from '../lib/cv/extraction/derive-experiences';
import { deriveLanguages, type DeriveLanguagesDeps } from '../lib/cv/extraction/derive-languages';
import type { ExtractionResult, SourceVariant } from '../lib/cv/extraction/types';
import { loadCatalogSnapshot } from '../lib/skills/catalog-loader';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[extract:cvs] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function parseBatchFlag(defaultValue: number): number {
  for (const arg of process.argv.slice(2)) {
    const match = /^--batch=(\d+)$/.exec(arg);
    if (match) {
      const n = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(n) && n > 0) return n;
    }
  }
  return defaultValue;
}

function buildDeps(db: SupabaseClient, provider: ExtractionProvider): CvExtractionWorkerDeps {
  return {
    listPending: (limit) =>
      listPendingExtractions(db, {
        model: provider.model,
        promptVersion: provider.promptVersion,
        limit,
      }),
    extractionExistsByHash: async (hash) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .select('id')
        .eq('content_hash', hash)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw new Error(error.message);
      return data !== null;
    },
    insertExtraction: async (row) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .insert({
          candidate_id: row.candidate_id,
          file_id: row.file_id,
          source_variant: row.source_variant,
          model: row.model,
          prompt_version: row.prompt_version,
          content_hash: row.content_hash,
          raw_output: row.raw_output,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'insertExtraction returned no row');
      return { id: data.id as string };
    },
    logRowError: async (input) => {
      const { error } = await db.from('sync_errors').insert({
        entity: input.entity,
        teamtailor_id: input.entity_id,
        error_message: input.message,
        run_started_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
    },
    deriveExperiences: (extractionId) => deriveExperiences(extractionId, buildDeriveDeps(db)),
    deriveLanguages: (extractionId) => deriveLanguages(extractionId, buildDeriveLanguagesDeps(db)),
    provider,
  };
}

/**
 * Wires the languages derivation service to Supabase. Same service-role
 * client as the worker (cross-tenant ETL, ADR-003).
 */
function buildDeriveLanguagesDeps(db: SupabaseClient): DeriveLanguagesDeps {
  return {
    loadExtraction: async (id) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .select('candidate_id, raw_output')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return null;
      return {
        candidate_id: data.candidate_id as string,
        raw_output: data.raw_output as ExtractionResult,
      };
    },
    hasExistingLanguages: async (extractionId) => {
      const { data, error } = await db
        .from('candidate_languages')
        .select('id')
        .eq('extraction_id', extractionId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
    insertLanguages: async (rows) => {
      if (rows.length === 0) return 0;
      const { data, error } = await db
        .from('candidate_languages')
        .insert(
          rows.map((r) => ({
            candidate_id: r.candidate_id,
            extraction_id: r.extraction_id,
            name: r.name,
            level: r.level,
          })),
        )
        .select('id');
      if (error) throw new Error(error.message);
      return (data ?? []).length;
    },
  };
}

/**
 * Wires the F4-005 derivation service to Supabase. Runs with the
 * same service-role client as the worker (cross-tenant ETL job,
 * ADR-003).
 */
function buildDeriveDeps(db: SupabaseClient): DeriveExperiencesDeps {
  return {
    loadExtraction: async (id) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .select('candidate_id, source_variant, raw_output')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return null;
      return {
        candidate_id: data.candidate_id as string,
        source_variant: data.source_variant as SourceVariant,
        raw_output: data.raw_output as ExtractionResult,
      };
    },
    loadCatalog: () => loadCatalogSnapshot(db),
    hasExistingExperiences: async (extractionId) => {
      const { data, error } = await db
        .from('candidate_experiences')
        .select('id')
        .eq('extraction_id', extractionId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
    insertExperiences: async (rows) => {
      if (rows.length === 0) return [];
      const payload = rows.map((r) => ({
        candidate_id: r.candidate_id,
        extraction_id: r.extraction_id,
        source_variant: r.source_variant,
        kind: r.kind,
        company: r.company,
        title: r.title,
        start_date: r.start_date,
        end_date: r.end_date,
        description: r.description,
      }));
      const { data, error } = await db
        .from('candidate_experiences')
        .insert(payload)
        .select('id, extraction_id, company, kind, start_date');
      if (error || !data) throw new Error(error?.message ?? 'insertExperiences returned no rows');
      // The worker guarantees same-order insert → we map positionally.
      if (data.length !== rows.length) {
        throw new Error(`insertExperiences: expected ${rows.length} rows, got ${data.length}`);
      }
      return data.map((d, i) => ({ temp_key: rows[i]!.temp_key, id: d.id as string }));
    },
    insertExperienceSkills: async (rows) => {
      if (rows.length === 0) return;
      const payload = rows.map((r) => ({
        experience_id: r.experience_id,
        skill_raw: r.skill_raw,
        skill_id: r.skill_id,
        resolved_at: r.resolved_at,
      }));
      const { error } = await db.from('experience_skills').insert(payload);
      if (error) throw new Error(error.message);
    },
  };
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
  const openaiKey = requireEnv('OPENAI_API_KEY');
  const model = process.env.OPENAI_EXTRACTION_MODEL ?? 'gpt-4o-mini';
  const defaultBatch = Number.parseInt(process.env.EXTRACT_BATCH_SIZE ?? '50', 10) || 50;
  const batchSize = parseBatchFlag(defaultBatch);

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const provider = createOpenAiExtractionProvider({ apiKey: openaiKey, model });

  try {
    const stats = await runCvExtractions(buildDeps(db, provider), { batchSize });
    // eslint-disable-next-line no-console
    console.log(
      `[extract:cvs] model=${model} promptVersion=${provider.promptVersion} ` +
        `processed=${stats.processed} extracted=${stats.extracted} ` +
        `skipped=${stats.skipped} errored=${stats.errored} ` +
        `experiences=${stats.experiencesInserted} skills=${stats.skillsInserted} ` +
        `derivationErrored=${stats.derivationErrored}`,
    );
    process.exit(0);
  } catch (e) {
    console.error('[extract:cvs] failed:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
