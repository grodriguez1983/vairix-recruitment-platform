/**
 * End-to-end integration test for F4-005 sub-C.
 *
 * Exercises the full chain against a real Supabase local instance
 * using a deterministic stub provider (no OpenAI key needed):
 *
 *   files (parsed_text) → runCvExtractions
 *     → candidate_extractions (INSERT)
 *     → deriveExperiences(extraction_id)
 *         → candidate_experiences (INSERT N rows)
 *         → experience_skills (INSERT M rows, skill_id resolved)
 *
 * Coverage target:
 *   1. Happy path — files parsed → rows land in both derived tables,
 *      skills are resolved (or null) via the seeded catalog.
 *   2. Idempotency — a second worker run over the same state inserts
 *      no new experiences (blocked by listPending's NOT-IN on
 *      extraction rows AND by deriveExperiences' hasExistingExperiences).
 *   3. Uncataloged skills land with skill_id=NULL + resolved_at=NULL
 *      so F4-009 (/admin/skills/uncataloged) can surface them.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  runCvExtractions,
  type CvExtractionWorkerDeps,
} from '../../../src/lib/cv/extraction/worker';
import {
  deriveExperiences,
  type DeriveExperiencesDeps,
} from '../../../src/lib/cv/extraction/derive-experiences';
import { createStubExtractionProvider } from '../../../src/lib/cv/extraction/stub-provider';
import { loadCatalogSnapshot } from '../../../src/lib/skills/catalog-loader';
import type { ExtractionResult, SourceVariant } from '../../../src/lib/cv/extraction/types';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const CANDIDATE_TT_ID = 'derive-e2e-test';
const TEST_SKILL_SLUG = 'derive-e2e-typescript';
const TEST_ALIAS = 'derive-e2e-react.js';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function fixtureWithTwoExperiences(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'Acme Corp',
        title: 'Senior Engineer',
        start_date: '2021-03',
        end_date: null,
        description: 'Built stuff.',
        skills: ['Derive-E2E-TypeScript', 'Derive-E2E-Uncataloged'],
      },
      {
        kind: 'side_project',
        company: 'Hobby LLC',
        title: null,
        start_date: '2019-01-15',
        end_date: '2020-06-30',
        description: null,
        skills: ['Derive-E2E-React.js'],
      },
    ],
    languages: [],
  };
}

function buildWorkerDeps(
  db: SupabaseClient,
  provider: ReturnType<typeof createStubExtractionProvider>,
): CvExtractionWorkerDeps {
  return {
    listPending: async (limit) => {
      const { data: existing, error: errE } = await db
        .from('candidate_extractions')
        .select('file_id')
        .eq('model', provider.model)
        .eq('prompt_version', provider.promptVersion);
      if (errE) throw new Error(errE.message);
      const excluded = (existing ?? []).map((r) => r.file_id);

      let q = db
        .from('files')
        .select('id, candidate_id, parsed_text')
        .is('deleted_at', null)
        .not('parsed_text', 'is', null)
        .is('parse_error', null)
        .order('created_at', { ascending: true })
        .limit(limit);
      if (excluded.length > 0) q = q.not('id', 'in', `(${excluded.join(',')})`);
      const { data, error } = await q;
      if (error) throw new Error(error.message);
      return (data ?? []).map((r) => ({
        file_id: r.id as string,
        candidate_id: r.candidate_id as string,
        parsed_text: r.parsed_text as string,
      }));
    },
    extractionExistsByHash: async (hash) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .select('id')
        .eq('content_hash', hash)
        .maybeSingle();
      if (error && error.code !== 'PGRST116') throw new Error(error.message);
      return data !== null;
    },
    insertExtraction: async (row) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .insert({
          candidate_id: row.candidate_id,
          file_id: row.file_id,
          source_variant: row.source_variant,
          model: row.model,
          prompt_version: row.prompt_version,
          content_hash: row.content_hash,
          raw_output: row.raw_output,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'insertExtraction returned no row');
      return { id: data.id as string };
    },
    logRowError: async (input) => {
      const { error } = await db.from('sync_errors').insert({
        entity: input.entity,
        teamtailor_id: input.entity_id,
        error_message: input.message,
        run_started_at: new Date().toISOString(),
      });
      if (error) throw new Error(error.message);
    },
    deriveExperiences: (extractionId) => deriveExperiences(extractionId, buildDeriveDeps(db)),
    provider,
  };
}

function buildDeriveDeps(db: SupabaseClient): DeriveExperiencesDeps {
  return {
    loadExtraction: async (id) => {
      const { data, error } = await db
        .from('candidate_extractions')
        .select('candidate_id, source_variant, raw_output')
        .eq('id', id)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return null;
      return {
        candidate_id: data.candidate_id as string,
        source_variant: data.source_variant as SourceVariant,
        raw_output: data.raw_output as ExtractionResult,
      };
    },
    loadCatalog: () => loadCatalogSnapshot(db),
    hasExistingExperiences: async (extractionId) => {
      const { data, error } = await db
        .from('candidate_experiences')
        .select('id')
        .eq('extraction_id', extractionId)
        .limit(1);
      if (error) throw new Error(error.message);
      return (data ?? []).length > 0;
    },
    insertExperiences: async (rows) => {
      if (rows.length === 0) return [];
      const payload = rows.map((r) => ({
        candidate_id: r.candidate_id,
        extraction_id: r.extraction_id,
        source_variant: r.source_variant,
        kind: r.kind,
        company: r.company,
        title: r.title,
        start_date: r.start_date,
        end_date: r.end_date,
        description: r.description,
      }));
      const { data, error } = await db.from('candidate_experiences').insert(payload).select('id');
      if (error || !data) throw new Error(error?.message ?? 'insertExperiences returned no rows');
      if (data.length !== rows.length) {
        throw new Error(`insertExperiences: expected ${rows.length} rows, got ${data.length}`);
      }
      return data.map((d, i) => ({ temp_key: rows[i]!.temp_key, id: d.id as string }));
    },
    insertExperienceSkills: async (rows) => {
      if (rows.length === 0) return;
      const payload = rows.map((r) => ({
        experience_id: r.experience_id,
        skill_raw: r.skill_raw,
        skill_id: r.skill_id,
        resolved_at: r.resolved_at,
      }));
      const { error } = await db.from('experience_skills').insert(payload);
      if (error) throw new Error(error.message);
    },
  };
}

describe('runCvExtractions + deriveExperiences (end-to-end)', () => {
  const db = svc();
  let candidateId: string;
  let testSkillId: string;
  const fileIds: string[] = [];

  beforeEach(async () => {
    // Isolated skill fixture: unique slug + alias so we don't
    // collide with the curated catalog already in the DB.
    await db.from('skill_aliases').delete().eq('alias_normalized', TEST_ALIAS);
    await db.from('skills').delete().eq('slug', TEST_SKILL_SLUG);
    const { data: skill, error: skillErr } = await db
      .from('skills')
      .insert({ canonical_name: 'Derive-E2E-TypeScript', slug: TEST_SKILL_SLUG })
      .select('id')
      .single();
    if (skillErr || !skill) throw new Error(skillErr?.message ?? 'skill seed failed');
    testSkillId = skill.id as string;
    await db
      .from('skill_aliases')
      .insert({ skill_id: testSkillId, alias_normalized: TEST_ALIAS, source: 'seed' });

    await db.from('candidates').delete().eq('teamtailor_id', CANDIDATE_TT_ID);
    const { data: cand } = await db
      .from('candidates')
      .insert({
        teamtailor_id: CANDIDATE_TT_ID,
        first_name: 'Derive',
        last_name: 'E2E',
        email: 'derive-e2e@example.test',
        raw_data: {},
      })
      .select('id')
      .single();
    candidateId = cand!.id as string;
    fileIds.length = 0;
  });

  afterEach(async () => {
    // experience_skills + candidate_experiences cascade from
    // candidate_extractions deletion (extraction_id FK on-delete-cascade).
    if (fileIds.length > 0) {
      await db.from('candidate_extractions').delete().in('file_id', fileIds);
    }
    await db.from('sync_errors').delete().eq('entity', 'cv_derivation');
    await db.from('files').delete().eq('candidate_id', candidateId);
    await db.from('candidates').delete().eq('id', candidateId);
    await db.from('skill_aliases').delete().eq('alias_normalized', TEST_ALIAS);
    await db.from('skills').delete().eq('slug', TEST_SKILL_SLUG);
  });

  async function seedFile(parsedText: string): Promise<string> {
    const { data: f, error } = await db
      .from('files')
      .insert({
        candidate_id: candidateId,
        storage_path: `${candidateId}/${Math.random().toString(36).slice(2)}.pdf`,
        file_type: 'cv',
        parsed_text: parsedText,
        parsed_at: new Date().toISOString(),
      })
      .select('id')
      .single();
    if (error || !f) throw new Error(error?.message ?? 'insert failed');
    fileIds.push(f.id as string);
    return f.id as string;
  }

  it('persists candidate_experiences + experience_skills end-to-end with resolver hits', async () => {
    await seedFile('parsed cv text for e2e derivation');
    const provider = createStubExtractionProvider({ fixture: fixtureWithTwoExperiences() });

    const stats = await runCvExtractions(buildWorkerDeps(db, provider));
    expect(stats.extracted).toBe(1);
    expect(stats.derivationErrored).toBe(0);
    expect(stats.experiencesInserted).toBe(2);
    expect(stats.skillsInserted).toBe(3);

    // Pull the real rows from SQL.
    const { data: extractionRow } = await db
      .from('candidate_extractions')
      .select('id')
      .eq('candidate_id', candidateId)
      .single();
    const extractionId = extractionRow!.id as string;

    const { data: experiences } = await db
      .from('candidate_experiences')
      .select('id, kind, company, start_date, end_date')
      .eq('extraction_id', extractionId)
      .order('company', { ascending: true });
    expect(experiences).toHaveLength(2);
    // Acme Corp (work) + Hobby LLC (side_project) alphabetical.
    expect(experiences![0]!.company).toBe('Acme Corp');
    expect(experiences![0]!.kind).toBe('work');
    expect(experiences![0]!.start_date).toBe('2021-03-01');
    expect(experiences![0]!.end_date).toBe(null);
    expect(experiences![1]!.company).toBe('Hobby LLC');
    expect(experiences![1]!.kind).toBe('side_project');

    const expIds = experiences!.map((e) => e.id as string);
    const { data: skills } = await db
      .from('experience_skills')
      .select('skill_raw, skill_id, resolved_at, experience_id')
      .in('experience_id', expIds);
    expect(skills).toHaveLength(3);

    const byRaw = new Map((skills ?? []).map((s) => [s.skill_raw, s]));
    // Exact match on slug.
    expect(byRaw.get('Derive-E2E-TypeScript')!.skill_id).toBe(testSkillId);
    expect(byRaw.get('Derive-E2E-TypeScript')!.resolved_at).not.toBeNull();
    // Alias match.
    expect(byRaw.get('Derive-E2E-React.js')!.skill_id).toBe(testSkillId);
    expect(byRaw.get('Derive-E2E-React.js')!.resolved_at).not.toBeNull();
    // Uncataloged.
    expect(byRaw.get('Derive-E2E-Uncataloged')!.skill_id).toBeNull();
    expect(byRaw.get('Derive-E2E-Uncataloged')!.resolved_at).toBeNull();
  });

  it('is idempotent end-to-end — a second worker run does not duplicate experiences or skills', async () => {
    await seedFile('parsed cv for idempotency check');
    const provider = createStubExtractionProvider({ fixture: fixtureWithTwoExperiences() });

    const first = await runCvExtractions(buildWorkerDeps(db, provider));
    expect(first.extracted).toBe(1);
    expect(first.experiencesInserted).toBe(2);
    expect(first.skillsInserted).toBe(3);

    const second = await runCvExtractions(buildWorkerDeps(db, provider));
    // listPending excludes files already extracted — worker doesn't
    // touch the extraction, so the derivation hook never runs either.
    expect(second.processed).toBe(0);
    expect(second.extracted).toBe(0);
    expect(second.experiencesInserted).toBe(0);
    expect(second.skillsInserted).toBe(0);

    // SQL check: still exactly 2 experiences + 3 skills.
    const { data: extractionRows } = await db
      .from('candidate_extractions')
      .select('id')
      .eq('candidate_id', candidateId);
    expect(extractionRows).toHaveLength(1);
    const { count: expCount } = await db
      .from('candidate_experiences')
      .select('*', { count: 'exact', head: true })
      .eq('extraction_id', extractionRows![0]!.id as string);
    expect(expCount).toBe(2);
  });
});
