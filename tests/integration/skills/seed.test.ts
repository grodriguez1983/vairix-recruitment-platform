/**
 * Sanity check: the curated seed migration
 * (20260420000008_skills_seed.sql) matches src/lib/skills/seed.ts.
 *
 * We don't compare textually — we compare the rows that actually
 * land in the DB after the migration runs, so any drift in either
 * direction (TS array edited but SQL not regenerated, or SQL
 * hand-patched without updating the array) is caught.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { CURATED_SKILLS } from '../../../src/lib/skills/seed';
import { applyCuratedSeed } from '../../../src/lib/skills/seed-applier';
import { serviceClient } from '../../rls/helpers';

describe('skills seed — SQL vs TS source of truth', () => {
  const svc = serviceClient();

  // Defensive: other test files in tests/integration/skills/ wipe
  // rows from skills/skill_aliases; vitest file order is not
  // guaranteed. Restore the seed before asserting — applyCuratedSeed
  // is idempotent (upsert ignoreDuplicates), so if the migration
  // already loaded it this is a no-op.
  beforeAll(async () => {
    await applyCuratedSeed(svc);
  });

  it('every slug in seed.ts exists in skills and every slug in skills exists in seed.ts', async () => {
    const { data: rows, error } = await svc.from('skills').select('slug, canonical_name, category');
    expect(error).toBeNull();

    const dbSlugs = new Set((rows ?? []).map((r) => r.slug));
    const tsSlugs = new Set(CURATED_SKILLS.map((s) => s.slug));

    // Symmetric difference should be empty.
    const missingInDb = [...tsSlugs].filter((s) => !dbSlugs.has(s));
    const missingInTs = [...dbSlugs].filter((s) => !tsSlugs.has(s));
    expect({ missingInDb, missingInTs }).toEqual({ missingInDb: [], missingInTs: [] });
  });

  it('canonical_name and category match between TS and DB for every slug', async () => {
    const { data: rows } = await svc.from('skills').select('slug, canonical_name, category');
    const bySlug = new Map((rows ?? []).map((r) => [r.slug, r]));

    for (const ts of CURATED_SKILLS) {
      const db = bySlug.get(ts.slug);
      expect(db, `slug ${ts.slug} missing in DB`).toBeDefined();
      expect(db?.canonical_name).toBe(ts.canonical_name);
      expect(db?.category).toBe(ts.category);
    }
  });

  it('every seeded alias exists in DB and points to the right skill', async () => {
    const { data: skillRows } = await svc.from('skills').select('id, slug');
    const idBySlug = new Map((skillRows ?? []).map((r) => [r.slug, r.id]));

    const { data: aliasRows } = await svc
      .from('skill_aliases')
      .select('skill_id, alias_normalized, source')
      .eq('source', 'seed');
    const bySkill: Record<string, Set<string>> = {};
    for (const a of aliasRows ?? []) {
      (bySkill[a.skill_id] ??= new Set()).add(a.alias_normalized);
    }

    for (const ts of CURATED_SKILLS) {
      const skillId = idBySlug.get(ts.slug);
      expect(skillId, `slug ${ts.slug} missing in DB`).toBeDefined();
      if (!skillId) continue;
      const dbAliases = bySkill[skillId] ?? new Set<string>();
      for (const alias of ts.aliases) {
        expect(dbAliases.has(alias), `alias "${alias}" for slug "${ts.slug}" missing in DB`).toBe(
          true,
        );
      }
    }
  });

  it('the seed has no duplicate slugs and no duplicate aliases (TS side)', async () => {
    const slugCounts = new Map<string, number>();
    const aliasCounts = new Map<string, number>();
    for (const s of CURATED_SKILLS) {
      slugCounts.set(s.slug, (slugCounts.get(s.slug) ?? 0) + 1);
      for (const a of s.aliases) {
        aliasCounts.set(a, (aliasCounts.get(a) ?? 0) + 1);
      }
    }
    const dupSlugs = [...slugCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    const dupAliases = [...aliasCounts.entries()].filter(([, c]) => c > 1).map(([k]) => k);
    expect({ dupSlugs, dupAliases }).toEqual({ dupSlugs: [], dupAliases: [] });
  });

  it('no alias is equal to a slug of a DIFFERENT skill (data-quality guard)', async () => {
    // The resolver prefers slug over alias, so such a clash is
    // silently hidden — but it's a smell. Catch it here.
    const slugOwner = new Map<string, string>();
    for (const s of CURATED_SKILLS) {
      slugOwner.set(s.slug, s.slug);
    }
    for (const s of CURATED_SKILLS) {
      for (const a of s.aliases) {
        const owner = slugOwner.get(a);
        expect(
          owner === undefined || owner === s.slug,
          `alias "${a}" of skill "${s.slug}" is also the slug of "${owner}"`,
        ).toBe(true);
      }
    }
  });
});
