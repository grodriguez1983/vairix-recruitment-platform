/**
 * CLI entry point: run every per-source embeddings worker sequentially
 * (profile → notes → cv). Use this as the routine post-ETL job.
 *
 * Sequential (not parallel) to keep the OpenAI rate limiter simple
 * and to give each source a clean structured-log section. Each worker
 * is already idempotent, so re-running is safe.
 *
 * Usage:
 *   pnpm embed:all              # run against OpenAI
 *   pnpm embed:all --stub       # smoke test, no API calls
 *
 * Required env vars:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *   - OPENAI_API_KEY             (only when not --stub)
 *
 * Exit codes:
 *   0 — all workers succeeded
 *   2 — configuration error
 *   4 — at least one worker failed (run aborts on first failure)
 */
import { createClient } from '@supabase/supabase-js';

import { runCvEmbeddings } from '../lib/embeddings/cv-worker';
import { runNotesEmbeddings } from '../lib/embeddings/notes-worker';
import { runProfileEmbeddings } from '../lib/embeddings/profile-worker';
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

  const sources: Array<{
    name: string;
    run: () => Promise<{
      processed: number;
      skipped: number;
      regenerated: number;
      reused: number;
    }>;
  }> = [
    { name: 'profile', run: () => runProfileEmbeddings(db, provider) },
    { name: 'notes', run: () => runNotesEmbeddings(db, provider) },
    { name: 'cv', run: () => runCvEmbeddings(db, provider) },
  ];

  for (const { name, run } of sources) {
    try {
      const r = await run();
      // eslint-disable-next-line no-console
      console.log(
        `[embed] ${name} done: processed=${r.processed} skipped=${r.skipped} ` +
          `regenerated=${r.regenerated} reused=${r.reused} (model=${provider.model})`,
      );
    } catch (e) {
      console.error(`[embed] ${name} failed:`, e instanceof Error ? e.message : e);
      process.exit(4);
    }
  }

  process.exit(0);
}

void main();
