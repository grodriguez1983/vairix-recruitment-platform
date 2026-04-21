/**
 * Integration tests for `reconcileUncatalogedSkills()` (ADR-013 §3).
 *
 * The reconciler is run (a) right after a seed/alias addition to
 * backfill historical uncataloged rows, and (b) periodically as a
 * maintenance job. Its two non-negotiables:
 *
 *   1. A resolvable `skill_raw` becomes a cataloged row with
 *      `skill_id` + `resolved_at` set.
 *   2. Idempotency: a second run over the same state updates 0 rows.
 *      Otherwise we'd keep rewriting `resolved_at` timestamps and
 *      bust the audit signal "this is when we first catalogued this".
 *
 * We also verify the reconciler does NOT touch rows with `skill_id`
 * already set (protect historical resolutions from drift).
 */
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { reconcileUncatalogedSkills } from '../../../src/lib/skills/reconcile';
import { applyCuratedSeed } from '../../../src/lib/skills/seed-applier';
import { serviceClient } from '../../rls/helpers';

type Svc = ReturnType<typeof serviceClient>;

// ────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────

async function seedChain(svc: Svc, ttId: string, hash: string): Promise<string> {
  const { data: cand } = await svc
    .from('candidates')
    .insert({ teamtailor_id: ttId, first_name: 'Recon' })
    .select('id')
    .single();
  const { data: file } = await svc
    .from('files')
    .insert({ candidate_id: cand!.id, storage_path: `cv/${ttId}.pdf` })
    .select('id')
    .single();
  const { data: ex } = await svc
    .from('candidate_extractions')
    .insert({
      candidate_id: cand!.id,
      file_id: file!.id,
      source_variant: 'cv_primary',
      model: 'gpt-4o-mini',
      prompt_version: '2026-04-v1',
      content_hash: hash,
      raw_output: {},
    })
    .select('id')
    .single();
  const { data: exp } = await svc
    .from('candidate_experiences')
    .insert({
      candidate_id: cand!.id,
      extraction_id: ex!.id,
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'Acme',
    })
    .select('id')
    .single();
  return exp!.id;
}

async function seedUncatalogedRow(svc: Svc, experienceId: string, raw: string): Promise<string> {
  const { data, error } = await svc
    .from('experience_skills')
    .insert({ experience_id: experienceId, skill_raw: raw, skill_id: null, resolved_at: null })
    .select('id')
    .single();
  if (error || !data) throw new Error(`seed experience_skills failed: ${error?.message}`);
  return data.id;
}

async function wipeExperienceGraph(svc: Svc): Promise<void> {
  await svc.from('experience_skills').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await svc
    .from('candidate_experiences')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  await svc
    .from('candidate_extractions')
    .delete()
    .neq('id', '00000000-0000-0000-0000-000000000000');
  await svc.from('files').delete().neq('id', '00000000-0000-0000-0000-000000000000');
  await svc.from('candidates').delete().neq('id', '00000000-0000-0000-0000-000000000000');
}

// ────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────

describe('integration: reconcileUncatalogedSkills', () => {
  const svc = serviceClient();

  beforeAll(async () => {
    // Other skill test files may have wiped the catalog between
    // runs; guarantee it's present for our resolves.
    await applyCuratedSeed(svc);
    await wipeExperienceGraph(svc);
  });

  afterEach(async () => {
    await wipeExperienceGraph(svc);
  });

  it('resolves cataloged skill_raw rows and leaves uncataloged ones alone', async () => {
    const expId = await seedChain(svc, 'recon-1', 'hash-recon-1');
    const resolvableId = await seedUncatalogedRow(svc, expId, 'React'); // curated
    const aliasHitId = await seedUncatalogedRow(svc, expId, 'reactjs'); // alias
    const unknownId = await seedUncatalogedRow(svc, expId, 'Fortran'); // uncataloged

    const stats = await reconcileUncatalogedSkills(svc);
    expect(stats.scanned).toBe(3);
    expect(stats.updated).toBe(2);
    expect(stats.stillUncataloged).toBe(1);

    const { data: rows } = await svc
      .from('experience_skills')
      .select('id, skill_id, resolved_at, skill_raw')
      .in('id', [resolvableId, aliasHitId, unknownId]);
    const byId = new Map((rows ?? []).map((r) => [r.id, r]));

    expect(byId.get(resolvableId)?.skill_id).not.toBeNull();
    expect(byId.get(resolvableId)?.resolved_at).not.toBeNull();

    expect(byId.get(aliasHitId)?.skill_id).not.toBeNull();
    expect(byId.get(aliasHitId)?.resolved_at).not.toBeNull();
    // The alias and the direct hit point to the same skill (React).
    expect(byId.get(aliasHitId)?.skill_id).toBe(byId.get(resolvableId)?.skill_id);

    expect(byId.get(unknownId)?.skill_id).toBeNull();
    expect(byId.get(unknownId)?.resolved_at).toBeNull();
  });

  it('is idempotent: a second run on the same DB state updates 0 rows', async () => {
    const expId = await seedChain(svc, 'recon-idem', 'hash-idem');
    await seedUncatalogedRow(svc, expId, 'TypeScript');
    await seedUncatalogedRow(svc, expId, 'node');
    await seedUncatalogedRow(svc, expId, 'something-uncataloged');

    const first = await reconcileUncatalogedSkills(svc);
    expect(first.updated).toBe(2);

    const second = await reconcileUncatalogedSkills(svc);
    expect(second.scanned).toBe(1); // only the still-uncataloged row
    expect(second.updated).toBe(0);
    expect(second.stillUncataloged).toBe(1);
  });

  it('does not touch rows that already have skill_id set', async () => {
    const expId = await seedChain(svc, 'recon-sticky', 'hash-sticky');

    // Seed a row that already has skill_id pointing to (say) React's id.
    const { data: reactSkill } = await svc.from('skills').select('id').eq('slug', 'react').single();
    const preResolvedAt = '2020-01-01T00:00:00Z';
    const { data: row } = await svc
      .from('experience_skills')
      .insert({
        experience_id: expId,
        skill_raw: 'React',
        skill_id: reactSkill!.id,
        resolved_at: preResolvedAt,
      })
      .select('id')
      .single();

    const stats = await reconcileUncatalogedSkills(svc);
    expect(stats.scanned).toBe(0);
    expect(stats.updated).toBe(0);

    const { data: after } = await svc
      .from('experience_skills')
      .select('resolved_at, skill_id')
      .eq('id', row!.id)
      .single();
    // resolved_at must NOT be overwritten — that's the audit anchor.
    // Postgres returns timestamptz as "...+00:00"; compare as Date.
    expect(new Date(after!.resolved_at!).toISOString()).toBe(new Date(preResolvedAt).toISOString());
    expect(after?.skill_id).toBe(reactSkill!.id);
  });

  it('normalizes input before resolving (whitespace / casing / terminal punct)', async () => {
    const expId = await seedChain(svc, 'recon-normalize', 'hash-normalize');
    const idA = await seedUncatalogedRow(svc, expId, '  POSTGRES  ');
    const idB = await seedUncatalogedRow(svc, expId, 'Node.js.');
    const idC = await seedUncatalogedRow(svc, expId, '\tTypeScript\n');

    const stats = await reconcileUncatalogedSkills(svc);
    expect(stats.updated).toBe(3);

    const { data } = await svc
      .from('experience_skills')
      .select('id, skill_id')
      .in('id', [idA, idB, idC]);
    for (const r of data ?? []) {
      expect(r.skill_id).not.toBeNull();
    }
  });
});
