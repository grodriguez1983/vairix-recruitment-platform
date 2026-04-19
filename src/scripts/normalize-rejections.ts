/**
 * CLI: classify pending `rejection_reason` values into
 * `rejection_category_id` + `needs_review` (ADR-007 §2).
 *
 * Modes:
 *   - default      → write changes for rows with no category yet
 *   - --dry-run    → classify and print samples, write nothing
 *   - --force      → reclassify every row that has a reason (even if
 *                    already normalized). Use after rule changes.
 *   - --batch=N    → upper bound on rows processed per run (default 500)
 *
 * Operator workflow:
 *   1. `pnpm normalize:rejections --dry-run` → sanity check
 *   2. `pnpm normalize:rejections`           → apply
 *   3. Spot-check the admin queue for `needs_review=true`
 *
 * Service-role key is required because this writes across all tenants
 * and bypasses RLS by design (ETL-class job, not a user flow).
 *
 * Required env vars:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *
 * Exit codes:
 *   0 — success
 *   2 — configuration error (missing env var, bad flag)
 *   4 — fatal error during run
 */
import { createClient } from '@supabase/supabase-js';

import { normalizeRejections } from '../lib/normalization/normalizer';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[normalize] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

function parseBatch(args: readonly string[]): number {
  const flag = args.find((a) => a.startsWith('--batch='));
  if (!flag) return 500;
  const raw = flag.slice('--batch='.length);
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    console.error(`[normalize] invalid --batch value: ${raw}`);
    process.exit(2);
  }
  return n;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const force = args.includes('--force');
  const batchSize = parseBatch(args);

  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const result = await normalizeRejections(db, { dryRun, force, batchSize });
    const tag = dryRun ? 'DRY-RUN' : 'APPLIED';
    // eslint-disable-next-line no-console
    console.log(
      `[normalize] ${tag} processed=${result.processed} matched=${result.matched} ` +
        `unmatched=${result.unmatched} (force=${force} batch=${batchSize})`,
    );
    if (result.samples.length > 0) {
      // eslint-disable-next-line no-console
      console.log(`[normalize] samples (up to ${result.samples.length}):`);
      for (const s of result.samples) {
        const flag = s.needsReview ? '⚠ review' : '✓';
        const truncated = s.reason.length > 80 ? `${s.reason.slice(0, 77)}...` : s.reason;
        // eslint-disable-next-line no-console
        console.log(`  [${flag}] ${s.code.padEnd(22)} ← ${truncated}`);
      }
    }
    process.exit(0);
  } catch (e) {
    console.error('[normalize] failed:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
