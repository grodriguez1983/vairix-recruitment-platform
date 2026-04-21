/**
 * Integration tests for `public.resolve_skill(text)` SQL helper.
 * Contract: ADR-013 §2. The SQL helper must mirror
 * `src/lib/skills/resolver.ts` (TS-side, lands in F4-002).
 *
 * Pipeline (ADR-013 §2):
 *   1. lowercase → trim → collapse internal whitespace
 *   2. strip terminal punctuation (., ,, ;, :) — preserve internal
 *      punctuation (c++, c#, node.js, ci/cd)
 *   3. exact match against skills.slug WHERE deprecated_at IS NULL
 *   4. alias match against skill_aliases.alias_normalized
 *   5. null when no match
 *
 * Invariant: the helper does NOT consult skills_blacklist (§5).
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { applyCuratedSeed } from '../../../src/lib/skills/seed-applier';
import { serviceClient } from '../../rls/helpers';

async function resolveSkill(
  svc: ReturnType<typeof serviceClient>,
  raw: string | null,
): Promise<string | null> {
  const { data, error } = await svc.rpc('resolve_skill', { raw });
  if (error) throw new Error(`resolve_skill RPC failed: ${error.message}`);
  return (data as string | null) ?? null;
}

async function seedSkill(
  svc: ReturnType<typeof serviceClient>,
  canonical: string,
  slug: string,
  opts: { deprecated?: boolean } = {},
): Promise<string> {
  const { data, error } = await svc
    .from('skills')
    .insert({
      canonical_name: canonical,
      slug,
      deprecated_at: opts.deprecated ? new Date().toISOString() : null,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed skill failed: ${error?.message ?? 'no row'}`);
  return data.id;
}

async function seedAlias(
  svc: ReturnType<typeof serviceClient>,
  skillId: string,
  alias: string,
): Promise<void> {
  const { error } = await svc
    .from('skill_aliases')
    .insert({ skill_id: skillId, alias_normalized: alias, source: 'seed' });
  if (error) throw new Error(`seed alias failed: ${error.message}`);
}

describe('sql: public.resolve_skill', () => {
  const svc = serviceClient();

  // The curated seed lands at migration time (20260420000008). These
  // tests insert ad-hoc fixtures on top and wipe ALL rows between
  // assertions for isolation — so we restore the seed at the end
  // with applyCuratedSeed() for any other test file that depends on it.
  beforeAll(async () => {
    await svc.from('skill_aliases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills_blacklist').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterEach(async () => {
    await svc.from('skill_aliases').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills_blacklist').delete().neq('id', '00000000-0000-0000-0000-000000000000');
    await svc.from('skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  });

  afterAll(async () => {
    await applyCuratedSeed(svc);
  });

  it('returns null for null input', async () => {
    expect(await resolveSkill(svc, null)).toBeNull();
  });

  it('returns null for empty / whitespace-only input', async () => {
    expect(await resolveSkill(svc, '')).toBeNull();
    expect(await resolveSkill(svc, '   ')).toBeNull();
    expect(await resolveSkill(svc, '\t\n')).toBeNull();
  });

  it('returns null for uncataloged input (no match)', async () => {
    expect(await resolveSkill(svc, 'Fortran')).toBeNull();
  });

  it('matches slug exactly (lowercase)', async () => {
    const skillId = await seedSkill(svc, 'React', 'react');
    expect(await resolveSkill(svc, 'React')).toBe(skillId);
    expect(await resolveSkill(svc, 'react')).toBe(skillId);
    expect(await resolveSkill(svc, 'REACT')).toBe(skillId);
  });

  it('matches slug with internal punctuation preserved', async () => {
    const nodeId = await seedSkill(svc, 'Node.js', 'node.js');
    expect(await resolveSkill(svc, 'Node.js')).toBe(nodeId);
    expect(await resolveSkill(svc, 'NODE.JS')).toBe(nodeId);

    const cppId = await seedSkill(svc, 'C++', 'c++');
    expect(await resolveSkill(svc, 'C++')).toBe(cppId);
    expect(await resolveSkill(svc, 'c++')).toBe(cppId);

    const csharpId = await seedSkill(svc, 'C#', 'c#');
    expect(await resolveSkill(svc, 'C#')).toBe(csharpId);

    const cicdId = await seedSkill(svc, 'CI/CD', 'ci/cd');
    expect(await resolveSkill(svc, 'CI/CD')).toBe(cicdId);
  });

  it('strips terminal punctuation only (., ,, ;, :)', async () => {
    const reactId = await seedSkill(svc, 'React', 'react');
    expect(await resolveSkill(svc, 'React.')).toBe(reactId);
    expect(await resolveSkill(svc, 'React,')).toBe(reactId);
    expect(await resolveSkill(svc, 'React;')).toBe(reactId);
    expect(await resolveSkill(svc, 'React:')).toBe(reactId);
    expect(await resolveSkill(svc, 'React..,;')).toBe(reactId);
  });

  it('trims leading and trailing whitespace', async () => {
    const reactId = await seedSkill(svc, 'React', 'react');
    expect(await resolveSkill(svc, '  React  ')).toBe(reactId);
    expect(await resolveSkill(svc, '\tReact\n')).toBe(reactId);
  });

  it('collapses internal whitespace', async () => {
    const id = await seedSkill(svc, 'React Native', 'react native');
    expect(await resolveSkill(svc, 'React  Native')).toBe(id);
    expect(await resolveSkill(svc, 'React\tNative')).toBe(id);
  });

  it('matches an alias when no direct slug hit', async () => {
    const reactId = await seedSkill(svc, 'React', 'react');
    await seedAlias(svc, reactId, 'reactjs');
    await seedAlias(svc, reactId, 'react.js');
    expect(await resolveSkill(svc, 'ReactJS')).toBe(reactId);
    expect(await resolveSkill(svc, 'react.js')).toBe(reactId);
  });

  it('prefers slug match over alias match', async () => {
    // If a string happens to match both a slug and an alias pointing
    // elsewhere, slug wins (ADR-013 §2 step 2 before step 3).
    const primaryId = await seedSkill(svc, 'React', 'react');
    const otherId = await seedSkill(svc, 'Legacy React', 'legacy-react');
    await seedAlias(svc, otherId, 'react');
    // The unique constraint on alias_normalized would actually block
    // this scenario in practice — but if the data were corrupted via
    // service role, the slug must win.
    expect(await resolveSkill(svc, 'React')).toBe(primaryId);
  });

  it('ignores deprecated skills on slug match', async () => {
    await seedSkill(svc, 'jQuery', 'jquery', { deprecated: true });
    expect(await resolveSkill(svc, 'jQuery')).toBeNull();
  });

  it('does NOT consult skills_blacklist (resolver bypasses it)', async () => {
    // Slug uses the normalized form (internal whitespace preserved as
    // single space, per ADR-013 §2). If blacklist also lists this
    // string, the resolver still returns the skill — blacklist is a
    // UI admin helper, not a resolver gate.
    const skillId = await seedSkill(svc, 'Team Player', 'team player');
    await svc.from('skills_blacklist').insert({ alias_normalized: 'team player' });
    expect(await resolveSkill(svc, 'Team Player')).toBe(skillId);
  });
});
