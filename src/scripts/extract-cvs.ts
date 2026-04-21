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

import { createOpenAiExtractionProvider } from '../lib/cv/extraction/providers/openai-extractor';
import { runCvExtractions, type CvExtractionWorkerDeps } from '../lib/cv/extraction/worker';
import type { ExtractionProvider } from '../lib/cv/extraction/provider';

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
    listPending: async (limit) => {
      const { data: existing, error: errE } = await db
        .from('candidate_extractions')
        .select('file_id')
        .eq('model', provider.model)
        .eq('prompt_version', provider.promptVersion);
      if (errE) throw new Error(errE.message);
      const excluded = (existing ?? []).map((r) => r.file_id);

      let q = db
        .from('files')
        .select('id, candidate_id, parsed_text')
        .is('deleted_at', null)
        .not('parsed_text', 'is', null)
        .is('parse_error', null)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (excluded.length > 0) q = q.not('id', 'in', `(${excluded.join(',')})`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({
        file_id: r.id as string,
        candidate_id: r.candidate_id as string,
        parsed_text: r.parsed_text as string,
      }));
    },
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
      const { error } = await db.from('candidate_extractions').insert({
        candidate_id: row.candidate_id,
        file_id: row.file_id,
        source_variant: row.source_variant,
        model: row.model,
        prompt_version: row.prompt_version,
        content_hash: row.content_hash,
        raw_output: row.raw_output,
      });
      if (error) throw new Error(error.message);
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
    provider,
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
        `skipped=${stats.skipped} errored=${stats.errored}`,
    );
    process.exit(0);
  } catch (e) {
    console.error('[extract:cvs] failed:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
