/**
 * Equivalence test: TS resolver (src/lib/skills/resolver.ts) vs
 * SQL helper (public.resolve_skill()).
 *
 * ADR-013 §2 requires both sides to produce the same result for any
 * input so extraction workers (TS) and admin reports / ranker
 * queries (SQL) see the same catalog. Drift between the two is a
 * silent, high-blast-radius bug: a skill could match in TS but not
 * in SQL, or vice versa, and only surface as "match scores look
 * weird" weeks later.
 *
 * Strategy:
 *   1. Build a `CatalogSnapshot` in TS from the real DB state
 *      (curated seed + any leftover fixtures).
 *   2. Run a battery of inputs through both sides and assert exact
 *      string equality on the returned skill_id (or `null`).
 *
 * The input battery mixes:
 *   - Seed slugs, aliases, and canonical names (happy path).
 *   - Weird-but-legal casing, whitespace, terminal punctuation.
 *   - Things that must return `null` (empty, whitespace, uncataloged).
 *
 * We do NOT use random inputs — the set is deterministic so a
 * failure is reproducible and each case documents a specific
 * invariant.
 */
import { beforeAll, describe, expect, it } from 'vitest';

import type { CatalogSnapshot } from '../../../src/lib/skills/resolver';
import { buildCatalogSnapshot, resolveSkill } from '../../../src/lib/skills/resolver';
import { applyCuratedSeed } from '../../../src/lib/skills/seed-applier';
import { serviceClient } from '../../rls/helpers';

async function loadSnapshot(svc: ReturnType<typeof serviceClient>): Promise<CatalogSnapshot> {
  const { data: skillRows, error: sErr } = await svc
    .from('skills')
    .select('id, slug, deprecated_at');
  if (sErr) throw new Error(`loadSnapshot skills: ${sErr.message}`);

  const { data: aliasRows, error: aErr } = await svc
    .from('skill_aliases')
    .select('skill_id, alias_normalized');
  if (aErr) throw new Error(`loadSnapshot aliases: ${aErr.message}`);

  return buildCatalogSnapshot(skillRows ?? [], aliasRows ?? []);
}

async function resolveSql(
  svc: ReturnType<typeof serviceClient>,
  raw: string | null,
): Promise<string | null> {
  const { data, error } = await svc.rpc('resolve_skill', { raw });
  if (error) throw new Error(`resolve_skill RPC failed: ${error.message}`);
  return (data as string | null) ?? null;
}

// Deterministic battery — each case documents what we're asserting.
const INPUTS: readonly (string | null)[] = [
  // Happy path: canonical names.
  'TypeScript',
  'Node.js',
  'React',
  'PostgreSQL',
  'AWS',
  // Mixed case + whitespace.
  '  React  ',
  '\tReactJS\n',
  'NODE.JS',
  'typescript',
  'TYPESCRIPT',
  // Terminal punctuation.
  'React.',
  'Python,',
  'AWS;',
  'Node.js:',
  'Docker..,;',
  // Internal whitespace collapse.
  'React  Native',
  'Ruby  on   Rails',
  'Spring\tBoot',
  // Internal punctuation preserved.
  'C++',
  'C#',
  'CI/CD',
  'ci-cd',
  '.net',
  'dotnet',
  // Aliases.
  'reactjs',
  'react.js',
  'nodejs',
  'k8s',
  'postgres',
  'psql',
  'es',
  'golang',
  // Uncataloged (must be null in both).
  'Fortran',
  'mi experiencia',
  'team player',
  '  ',
  '',
  null,
  // Edge: a string that looks like a slug but with trailing junk.
  'react!',
  'react?',
  // Internal dot vs slug without dot.
  'react.js',
];

describe('equivalence: TS resolver vs SQL resolve_skill', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    // Guarantee the catalog is populated regardless of sibling
    // test file order (see seed-applier rationale).
    await applyCuratedSeed(svc);
  });

  it(`both sides agree on ${INPUTS.length} deterministic inputs`, async () => {
    const catalog = await loadSnapshot(svc);

    const divergences: Array<{ input: string | null; ts: string | null; sql: string | null }> = [];
    for (const input of INPUTS) {
      const tsResult = resolveSkill(input, catalog);
      const ts = tsResult?.skill_id ?? null;
      const sql = await resolveSql(svc, input);
      if (ts !== sql) {
        divergences.push({ input, ts, sql });
      }
    }
    expect(divergences).toEqual([]);
  });

  it('a random sample of aliases from the DB resolves identically on both sides', async () => {
    // Takes whatever aliases actually exist in the DB (so this test
    // scales if the seed grows) and verifies exact agreement.
    const { data: rows } = await svc.from('skill_aliases').select('alias_normalized').limit(50);
    const aliases = (rows ?? []).map((r) => r.alias_normalized);
    expect(aliases.length).toBeGreaterThan(10);

    const catalog = await loadSnapshot(svc);
    for (const alias of aliases) {
      const ts = resolveSkill(alias, catalog)?.skill_id ?? null;
      const sql = await resolveSql(svc, alias);
      expect(ts, `divergence on alias "${alias}"`).toBe(sql);
    }
  });

  it('a random sample of slugs from the DB resolves identically on both sides', async () => {
    const { data: rows } = await svc.from('skills').select('slug').is('deprecated_at', null);
    const slugs = (rows ?? []).map((r) => r.slug);
    expect(slugs.length).toBeGreaterThan(10);

    const catalog = await loadSnapshot(svc);
    for (const slug of slugs) {
      // Feed the slug "as-is" (lowercase, original casing) and also
      // uppercased to exercise the normalizer.
      for (const variant of [slug, slug.toUpperCase(), `  ${slug}  `]) {
        const ts = resolveSkill(variant, catalog)?.skill_id ?? null;
        const sql = await resolveSql(svc, variant);
        expect(ts, `divergence on slug variant "${variant}"`).toBe(sql);
      }
    }
  });
});
