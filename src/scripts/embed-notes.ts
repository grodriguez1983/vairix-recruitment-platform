/**
 * CLI entry point: regenerate notes embeddings for all active
 * candidates using the OpenAI provider.
 *
 * Mirrors embed-profiles.ts — same env vars, same exit codes, same
 * --stub flag. See ADR-005 §Fuentes a embeber for why the notes
 * source is its own aggregate.
 *
 * Usage:
 *   pnpm embed:notes              # run against OpenAI
 *   pnpm embed:notes --stub       # smoke test, no API calls
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

import { runNotesEmbeddings } from '../lib/embeddings/notes-worker';
import { createOpenAiProvider } from '../lib/embeddings/openai-provider';
import { createStubProvider } from '../lib/embeddings/stub-provider';
import type { EmbeddingProvider } from '../lib/embeddings/provider';

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
  const model = process.env.EMBEDDINGS_MODEL ?? 'text-embedding-3-small';

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  let provider: EmbeddingProvider;
  if (useStub) {
    provider = createStubProvider({ model: 'stub-cli', dim: 1536 });
  } else {
    const apiKey = requireEnv('OPENAI_API_KEY');
    provider = createOpenAiProvider({ apiKey, model, dim: 1536 });
  }

  try {
    const result = await runNotesEmbeddings(db, provider);
    // eslint-disable-next-line no-console
    console.log(
      `[embed] notes done: processed=${result.processed} skipped=${result.skipped} ` +
        `regenerated=${result.regenerated} reused=${result.reused} (model=${provider.model})`,
    );
    process.exit(0);
  } catch (e) {
    console.error('[embed] notes failed:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
