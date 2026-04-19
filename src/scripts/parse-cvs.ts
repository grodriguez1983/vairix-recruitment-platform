/**
 * CLI entry point: parse CV binaries that landed via the uploads
 * syncer or the manual VAIRIX sheet endpoint but still have
 * `parsed_text = null AND parse_error = null`.
 *
 * Idempotent and safe to re-run — each invocation pulls a fresh batch
 * of pending rows. A failed row stays failed (parse_error set) until
 * an operator clears `parse_error = null` to retry.
 *
 * Usage:
 *   pnpm parse:cvs                 # default batchSize=50
 *   pnpm parse:cvs --batch=10      # smaller batch
 *
 * Required env vars:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY          (service role — bypasses RLS)
 *
 * Exit codes:
 *   0 — success
 *   2 — configuration error
 *   4 — fatal error during run
 */
import { createClient } from '@supabase/supabase-js';

import { runCvParseWorker } from '../lib/cv/parse-worker';
import { BUCKET as CV_BUCKET } from '../lib/cv/downloader';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[parse] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function parseBatchFlag(argv: string[]): number {
  for (const arg of argv) {
    const m = /^--batch=(\d+)$/.exec(arg);
    if (m) return Number(m[1]);
  }
  return 50;
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');
  const batchSize = parseBatchFlag(process.argv.slice(2));

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const bucket = db.storage.from(CV_BUCKET);

  // Lazy-load pdf-parse + mammoth so scripts that don't need parsing
  // (sync, embeddings) pay nothing for these heavy imports.
  const [pdfParseMod, mammothMod] = await Promise.all([import('pdf-parse'), import('mammoth')]);
  const pdfParse = (pdfParseMod as { default: (buf: Buffer) => Promise<{ text: string }> }).default;
  const mammoth = mammothMod as {
    extractRawText: (args: { buffer: Buffer }) => Promise<{ value: string }>;
  };

  try {
    const result = await runCvParseWorker(
      {
        listPending: async (limit) => {
          const { data, error } = await db
            .from('files')
            .select('id, storage_path, file_type')
            .is('deleted_at', null)
            .is('parsed_text', null)
            .is('parse_error', null)
            .order('created_at', { ascending: true })
            .limit(limit);
          if (error) throw new Error(`listPending failed: ${error.message}`);
          return (data ?? []) as Array<{ id: string; storage_path: string; file_type: string }>;
        },
        download: async (path) => {
          const { data, error } = await bucket.download(path);
          if (error || !data) {
            throw new Error(`download failed for ${path}: ${error?.message ?? 'no data returned'}`);
          }
          return Buffer.from(await data.arrayBuffer());
        },
        update: async (id, patch) => {
          const { error } = await db.from('files').update(patch).eq('id', id);
          if (error) throw new Error(`update ${id} failed: ${error.message}`);
        },
        parser: {
          parsePdf: (buf) => pdfParse(buf),
          parseDocx: (buf) => mammoth.extractRawText({ buffer: buf }),
        },
      },
      { batchSize },
    );
    // eslint-disable-next-line no-console
    console.log(
      `[parse] done: processed=${result.processed} parsed=${result.parsed} errored=${result.errored}`,
    );
    process.exit(0);
  } catch (e) {
    console.error('[parse] fatal:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
