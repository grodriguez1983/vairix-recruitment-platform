/**
 * RED — ADR-033 §RPC #2 `match_load_aggregates`.
 *
 * Replaces the two TS helpers `loadExperiences` + `loadLanguages`
 * with a single server-side aggregation that returns one JSONB row
 * per candidate, shaped exactly like the ranker's `CandidateAggregate`
 * (minus the post-merge step — `mergeVariants` stays in TS, see
 * ADR-033 §2).
 *
 * The contract under test:
 *   - Input: `candidate_ids_in uuid[]`, `tenant_id_in uuid`.
 *   - Output: JSONB array. One element per candidate matching the
 *     input array; element is `{ candidate_id, experiences[],
 *     languages[] }`. Candidates not in the input array MUST NOT
 *     appear.
 *   - `experiences[i]` mirrors `CandidateExperienceRow` from
 *     `load-candidate-aggregates.ts:21-32` plus the nested
 *     `skills: [{ skill_id, skill_raw }]`.
 *   - `languages[i]` mirrors `CandidateLanguageRow` —
 *     `{ name, level }`.
 *   - Order WITHIN experiences[] / languages[] is unspecified;
 *     consumers must not depend on it (mergeVariants doesn't).
 *
 * RED state: until the migration creates the function, every test
 * fails with `function ... does not exist`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { SupabaseClient } from '@supabase/supabase-js';

import { serviceClient } from '../../rls/helpers';

const FIXTURE_TT_PREFIX = 'adr033-agg-';
const FIXTURE_SKILL_SLUG_PREFIX = 'adr033-agg-skill-';

interface SeededCandidate {
  id: string;
  label: string;
}

async function deleteFixtureArtifacts(db: SupabaseClient): Promise<void> {
  await db.from('candidates').delete().like('teamtailor_id', `${FIXTURE_TT_PREFIX}%`);
  await db.from('skills').delete().like('slug', `${FIXTURE_SKILL_SLUG_PREFIX}%`);
}

async function insertOne(
  db: SupabaseClient,
  table: string,
  row: Record<string, unknown>,
  returning = 'id',
): Promise<Record<string, unknown>> {
  const { data, error } = await db.from(table).insert(row).select(returning).single();
  if (error || !data) throw new Error(`insert ${table}: ${error?.message ?? 'no data'}`);
  return data as unknown as Record<string, unknown>;
}

async function seedSkill(db: SupabaseClient, name: string): Promise<string> {
  const slug = `${FIXTURE_SKILL_SLUG_PREFIX}${name}`;
  const row = await insertOne(db, 'skills', { canonical_name: name, slug });
  return row.id as string;
}

async function seedCandidateScaffold(
  db: SupabaseClient,
  label: string,
): Promise<{ candidateId: string; extractionId: string }> {
  const ttId = `${FIXTURE_TT_PREFIX}${label}`;
  const cand = await insertOne(db, 'candidates', {
    teamtailor_id: ttId,
    first_name: 'AGG',
    last_name: `Cand-${label}`,
  });
  const file = await insertOne(db, 'files', {
    candidate_id: cand.id,
    storage_path: `cv/${ttId}.pdf`,
  });
  const extraction = await insertOne(db, 'candidate_extractions', {
    candidate_id: cand.id,
    file_id: file.id,
    source_variant: 'cv_primary',
    model: 'stub-extract-v1',
    prompt_version: 'stub-extract-prompt-v1',
    content_hash: `adr033-agg-${label}`,
    raw_output: {},
  });
  return { candidateId: cand.id as string, extractionId: extraction.id as string };
}

async function seedExperience(
  db: SupabaseClient,
  candidateId: string,
  extractionId: string,
  attrs: {
    source_variant?: 'cv_primary' | 'linkedin_export';
    kind?: 'work' | 'side_project' | 'education';
    company?: string | null;
    title?: string | null;
    start_date?: string | null;
    end_date?: string | null;
    description?: string | null;
    skills?: Array<{ skill_id: string | null; skill_raw: string }>;
  },
): Promise<string> {
  const exp = await insertOne(db, 'candidate_experiences', {
    candidate_id: candidateId,
    extraction_id: extractionId,
    source_variant: attrs.source_variant ?? 'cv_primary',
    kind: attrs.kind ?? 'work',
    company: attrs.company ?? null,
    title: attrs.title ?? null,
    start_date: attrs.start_date ?? null,
    end_date: attrs.end_date ?? null,
    description: attrs.description ?? null,
  });
  for (const s of attrs.skills ?? []) {
    await db.from('experience_skills').insert({
      experience_id: exp.id,
      skill_id: s.skill_id,
      skill_raw: s.skill_raw,
    });
  }
  return exp.id as string;
}

async function seedLanguage(
  db: SupabaseClient,
  candidateId: string,
  extractionId: string,
  name: string,
  level: string | null,
): Promise<void> {
  await db.from('candidate_languages').insert({
    candidate_id: candidateId,
    extraction_id: extractionId,
    name,
    level,
  });
}

describe('match_load_aggregates RPC — ADR-033 §RPC #2', () => {
  const db = serviceClient();
  let skillTs: string;
  let skillReact: string;
  let candX: SeededCandidate; // 2 experiences, 1 language
  let candY: SeededCandidate; // 1 experience, 2 languages
  let candZ: SeededCandidate; // no experiences, no languages

  beforeAll(async () => {
    await deleteFixtureArtifacts(db);
    skillTs = await seedSkill(db, 'typescript');
    skillReact = await seedSkill(db, 'react');

    const xScaffold = await seedCandidateScaffold(db, 'X');
    candX = { id: xScaffold.candidateId, label: 'X' };
    await seedExperience(db, xScaffold.candidateId, xScaffold.extractionId, {
      kind: 'work',
      company: 'AcmeX',
      title: 'Engineer',
      start_date: '2022-01-01',
      end_date: '2023-12-31',
      description: 'work on platform',
      skills: [
        { skill_id: skillTs, skill_raw: 'TypeScript' },
        { skill_id: skillReact, skill_raw: 'React.js' },
      ],
    });
    await seedExperience(db, xScaffold.candidateId, xScaffold.extractionId, {
      kind: 'side_project',
      company: null,
      title: 'OSS',
      start_date: '2024-01-01',
      end_date: null,
      description: null,
      skills: [{ skill_id: null, skill_raw: 'unknown-tool' }],
    });
    await seedLanguage(db, xScaffold.candidateId, xScaffold.extractionId, 'English', 'C1');

    const yScaffold = await seedCandidateScaffold(db, 'Y');
    candY = { id: yScaffold.candidateId, label: 'Y' };
    await seedExperience(db, yScaffold.candidateId, yScaffold.extractionId, {
      source_variant: 'linkedin_export',
      kind: 'work',
      company: 'AcmeY',
      title: 'Lead',
      start_date: '2020-06-01',
      end_date: null,
      skills: [{ skill_id: skillTs, skill_raw: 'TS' }],
    });
    await seedLanguage(db, yScaffold.candidateId, yScaffold.extractionId, 'Spanish', 'native');
    await seedLanguage(db, yScaffold.candidateId, yScaffold.extractionId, 'Portuguese', null);

    const zScaffold = await seedCandidateScaffold(db, 'Z');
    candZ = { id: zScaffold.candidateId, label: 'Z' };
    // no experiences, no languages — just the scaffold.
  }, 60_000);

  afterAll(async () => {
    await deleteFixtureArtifacts(db);
  });

  async function callRpc(ids: string[]): Promise<
    Array<{
      candidate_id: string;
      experiences: Array<{
        id: string;
        source_variant: string;
        kind: string;
        company: string | null;
        title: string | null;
        start_date: string | null;
        end_date: string | null;
        description: string | null;
        skills: Array<{ skill_id: string | null; skill_raw: string }>;
      }>;
      languages: Array<{ name: string; level: string | null }>;
    }>
  > {
    const { data, error } = await db.rpc('match_load_aggregates', {
      candidate_ids_in: ids,
      tenant_id_in: null,
    });
    if (error) throw new Error(`match_load_aggregates rpc: ${error.message}`);
    return data as never;
  }

  it('empty input → empty array, no RPC error', async () => {
    const out = await callRpc([]);
    expect(out).toEqual([]);
  });

  it('returns one entry per requested candidate, no extras', async () => {
    const out = await callRpc([candX.id, candY.id]);
    expect(out).toHaveLength(2);
    expect(new Set(out.map((c) => c.candidate_id))).toEqual(new Set([candX.id, candY.id]));
  });

  it('candidates with no experiences or languages return empty arrays (not null)', async () => {
    const out = await callRpc([candZ.id]);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidate_id).toBe(candZ.id);
    expect(out[0]!.experiences).toEqual([]);
    expect(out[0]!.languages).toEqual([]);
  });

  it('experiences carry the full row shape including nested skills', async () => {
    const [cand] = await callRpc([candX.id]);
    expect(cand!.experiences).toHaveLength(2);

    const work = cand!.experiences.find((e) => e.kind === 'work');
    expect(work).toBeDefined();
    expect(work).toMatchObject({
      source_variant: 'cv_primary',
      kind: 'work',
      company: 'AcmeX',
      title: 'Engineer',
      start_date: '2022-01-01',
      end_date: '2023-12-31',
      description: 'work on platform',
    });
    const workSkills = new Map(work!.skills.map((s) => [s.skill_raw, s.skill_id]));
    expect(workSkills.get('TypeScript')).toBe(skillTs);
    expect(workSkills.get('React.js')).toBe(skillReact);

    const side = cand!.experiences.find((e) => e.kind === 'side_project');
    expect(side).toBeDefined();
    expect(side!.company).toBeNull();
    expect(side!.skills).toHaveLength(1);
    expect(side!.skills[0]!.skill_id).toBeNull();
    expect(side!.skills[0]!.skill_raw).toBe('unknown-tool');
  });

  it('languages carry { name, level } including null level', async () => {
    const [cand] = await callRpc([candY.id]);
    const byName = new Map(cand!.languages.map((l) => [l.name, l.level]));
    expect(byName.get('Spanish')).toBe('native');
    expect(byName.get('Portuguese')).toBeNull();
  });

  it('omits candidates not in the input array', async () => {
    // Ask for X only; Y and Z must not appear even though they exist
    // and are visible to service_role.
    const out = await callRpc([candX.id]);
    expect(out.map((c) => c.candidate_id)).toEqual([candX.id]);
  });

  it('source_variant is preserved per experience row (cv_primary vs linkedin_export)', async () => {
    // mergeVariants in TS depends on this. Y has a single linkedin row.
    const [cand] = await callRpc([candY.id]);
    expect(cand!.experiences).toHaveLength(1);
    expect(cand!.experiences[0]!.source_variant).toBe('linkedin_export');
  });
});
