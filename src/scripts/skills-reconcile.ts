/**
 * CLI: re-resolve `experience_skills.skill_id` rows that are still
 * NULL against the current catalog (ADR-013 §3).
 *
 * When to run:
 *   - After adding new skills/aliases via /admin/skills (post-curation
 *     backfill of historical mentions).
 *   - Periodically as a maintenance job (e.g. weekly) to pick up
 *     derived aliases or recently-accepted curations.
 *
 * Modes:
 *   - default     → write updates
 *   - (no dry-run flag for now — reconciliation is idempotent and
 *     low-risk; re-run without side effects if unsure)
 *
 * Service-role key is required: this is an ETL-class job that spans
 * tenants and bypasses RLS (not user-triggered).
 *
 * Required env vars:
 *   - NEXT_PUBLIC_SUPABASE_URL
 *   - SUPABASE_SECRET_KEY
 *
 * Exit codes:
 *   0 — success (including zero updates)
 *   2 — configuration error
 *   4 — fatal error during run
 */
import { createClient } from '@supabase/supabase-js';

import { reconcileUncatalogedSkills } from '../lib/skills/reconcile';

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    console.error(`[skills:reconcile] missing required env var: ${name}`);
    process.exit(2);
  }
  return v;
}

async function main(): Promise<void> {
  const supabaseUrl = requireEnv('NEXT_PUBLIC_SUPABASE_URL');
  const supabaseKey = requireEnv('SUPABASE_SECRET_KEY');

  const db = createClient(supabaseUrl, supabaseKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const stats = await reconcileUncatalogedSkills(db);
    // eslint-disable-next-line no-console
    console.log(
      `[skills:reconcile] scanned=${stats.scanned} updated=${stats.updated} ` +
        `stillUncataloged=${stats.stillUncataloged}`,
    );
    process.exit(0);
  } catch (e) {
    console.error('[skills:reconcile] failed:', e instanceof Error ? e.message : e);
    process.exit(4);
  }
}

void main();
