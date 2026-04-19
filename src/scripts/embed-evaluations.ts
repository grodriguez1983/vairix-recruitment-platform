/**
 * CLI entry point: regenerate evaluation embeddings for all active
 * candidates using the OpenAI provider.
 *
 * Mirrors embed-notes.ts — same env vars, same exit codes, same
 * --stub flag. See ADR-005 §Fuentes a embeber for why the evaluation
 * source is its own aggregate.
 *
 * Usage:
 *   pnpm embed:evaluations              # run against OpenAI
 *   pnpm embed:evaluations --stub       # smoke test, no API calls
 *
 * Required env vars:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - OPENAI_API_KEY              (only when not --stub)
 *
 * Optional:
 *   - EMBEDDINGS_MODEL            (default: text-embedding-3-small)
 *
 * Exit codes:
 *   0 — success
 *   2 — configuration error (missing env var)
 *   4 — fatal error during run
 */
import { createClient } from '@supabase/supabase-js';

import { runEvaluationEmbeddings } from '../lib/embeddings/evaluation-worker';
import { resolveEmbeddingProvider } from '../lib/embeddings/provider-factory';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[embed] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const useStub = args.includes('--stub');

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let provider;
  try {
    provider = resolveEmbeddingProvider({ useStub });
  } catch (e) {
    console.error(`[embed] ${e instanceof Error ? e.message : e}`);
    process.exit(2);
  }

  try {
    const result = await runEvaluationEmbeddings(db, provider);
    // eslint-disable-next-line no-console
    console.log(
      `[embed] evaluations done: processed=${result.processed} skipped=${result.skipped} ` +
        `regenerated=${result.regenerated} reused=${result.reused} (model=${provider.model})`,
    );
    process.exit(0);
  } catch (e) {
    console.error('[embed] evaluations failed:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
