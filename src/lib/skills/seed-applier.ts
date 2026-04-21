/**
 * Applies `CURATED_SKILLS` (src/lib/skills/seed.ts) to a Supabase
 * DB via the JS client.
 *
 * This mirrors migration 20260420000008_skills_seed.sql. It exists
 * so integration tests that wipe `skills` / `skill_aliases` in
 * their setup/teardown can restore the seed without running the
 * SQL migration.
 *
 * Not used in production paths — the migration remains the real
 * seed mechanism. Keep this in sync with the migration: the
 * migration is still the source of truth at deploy-time.
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import { CURATED_SKILLS } from './seed';

type SkillRow = { slug: string; id: string };

/**
 * Inserts all curated skills + aliases. Uses upsert semantics on
 * slug / alias_normalized so the call is idempotent: a second
 * invocation is a no-op. Requires a service-role client (RLS
 * otherwise blocks writes).
 */
export async function applyCuratedSeed(svc: SupabaseClient): Promise<void> {
  const { error: skillsErr } = await svc.from('skills').upsert(
    CURATED_SKILLS.map((s) => ({
      canonical_name: s.canonical_name,
      slug: s.slug,
      category: s.category,
    })),
    { onConflict: 'slug', ignoreDuplicates: true },
  );
  if (skillsErr) {
    throw new Error(`applyCuratedSeed: skills upsert failed: ${skillsErr.message}`);
  }

  const { data: rows, error: readErr } = await svc.from('skills').select('id, slug');
  if (readErr || !rows) {
    throw new Error(`applyCuratedSeed: skills read failed: ${readErr?.message ?? 'no rows'}`);
  }
  const idBySlug = new Map<string, string>((rows as SkillRow[]).map((r) => [r.slug, r.id]));

  const aliasRows = CURATED_SKILLS.flatMap((s) =>
    s.aliases.map((alias) => ({
      skill_id: idBySlug.get(s.slug)!,
      alias_normalized: alias,
      source: 'seed' as const,
    })),
  );

  if (aliasRows.length === 0) return;

  const { error: aliasErr } = await svc
    .from('skill_aliases')
    .upsert(aliasRows, { onConflict: 'alias_normalized', ignoreDuplicates: true });
  if (aliasErr) {
    throw new Error(`applyCuratedSeed: aliases upsert failed: ${aliasErr.message}`);
  }
}
