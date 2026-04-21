/**
 * Unit tests for `deriveExperiences` (F4-005 sub-B).
 *
 * Service layer: orchestrates the pure sub-A derivation with DB I/O.
 * All I/O is injected so this suite needs no Supabase. The
 * integration test in sub-C covers the real SQL path.
 *
 * Contract:
 *   1. Loads extraction row. Missing → throws.
 *   2. Idempotent: if any candidate_experiences rows already exist
 *      for `extraction_id`, returns `{ skipped: true }` and writes
 *      nothing. Re-running the derivation is a no-op, which lets the
 *      worker retry failed batches safely.
 *   3. Loads catalog once per call (consistent-within-call, ADR-013 §2).
 *   4. Calls `insertExperiences` with the derived tuples; receives
 *      back the real DB ids, stitches them to the skill tuples via
 *      temp_key, then calls `insertExperienceSkills`.
 *   5. `resolved_at` is set to a real timestamp (ISO) at the service
 *      layer — sub-A used a deterministic marker; this layer replaces
 *      it with the injected `now()` for rows whose resolution succeeded.
 *   6. Zero skills in the raw_output → experiences insert still
 *      happens, skill insert is skipped (empty array).
 */
import { describe, expect, it, vi } from 'vitest';

import { buildCatalogSnapshot } from '../../skills/resolver';

import {
  deriveExperiences,
  type DeriveExperiencesDeps,
  type ExperienceInsertRow,
  type ExperienceSkillInsertRow,
} from './derive-experiences';
import type { ExtractionResult } from './types';

const EXTRACTION_ID = '00000000-0000-0000-0000-000000000010';
const CANDIDATE_ID = '00000000-0000-0000-0000-000000000020';
const EXP_ID_1 = '00000000-0000-0000-0000-000000000031';
const EXP_ID_2 = '00000000-0000-0000-0000-000000000032';
const REACT_ID = '10000000-0000-0000-0000-000000000002';

function rawOutput(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'Acme',
        title: 'Senior',
        start_date: '2021-06',
        end_date: null,
        description: null,
        skills: ['React.js', 'UncatalogedStuff'],
      },
    ],
    languages: [],
  };
}

function rawOutputTwoExperiences(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'A',
        title: null,
        start_date: null,
        end_date: null,
        description: null,
        skills: ['React.js'],
      },
      {
        kind: 'side_project',
        company: 'B',
        title: null,
        start_date: null,
        end_date: null,
        description: null,
        skills: ['UncatalogedStuff'],
      },
    ],
    languages: [],
  };
}

function makeDeps(overrides: Partial<DeriveExperiencesDeps> = {}): DeriveExperiencesDeps {
  const base: DeriveExperiencesDeps = {
    loadExtraction: async () => ({
      candidate_id: CANDIDATE_ID,
      source_variant: 'cv_primary',
      raw_output: rawOutput(),
    }),
    loadCatalog: async () =>
      buildCatalogSnapshot(
        [{ id: REACT_ID, slug: 'react', deprecated_at: null }],
        [{ skill_id: REACT_ID, alias_normalized: 'react.js' }],
      ),
    hasExistingExperiences: async () => false,
    insertExperiences: async (rows) =>
      rows.map((r, i) => ({ temp_key: r.temp_key, id: i === 0 ? EXP_ID_1 : EXP_ID_2 })),
    insertExperienceSkills: async () => {
      /* noop */
    },
    now: () => new Date('2026-04-20T12:00:00.000Z'),
  };
  return { ...base, ...overrides };
}

describe('deriveExperiences (service)', () => {
  it('inserts experiences, stitches real ids onto skills, and inserts skills', async () => {
    const insertedExperiences: ExperienceInsertRow[] = [];
    const insertedSkills: ExperienceSkillInsertRow[] = [];
    const deps = makeDeps({
      insertExperiences: async (rows) => {
        insertedExperiences.push(...rows);
        return rows.map((r) => ({ temp_key: r.temp_key, id: EXP_ID_1 }));
      },
      insertExperienceSkills: async (rows) => {
        insertedSkills.push(...rows);
      },
    });

    const result = await deriveExperiences(EXTRACTION_ID, deps);

    expect(result.skipped).toBe(false);
    expect(result.experiencesInserted).toBe(1);
    expect(result.skillsInserted).toBe(2);
    expect(insertedExperiences).toHaveLength(1);
    expect(insertedExperiences[0]!.candidate_id).toBe(CANDIDATE_ID);
    expect(insertedExperiences[0]!.extraction_id).toBe(EXTRACTION_ID);
    expect(insertedExperiences[0]!.start_date).toBe('2021-06-01');
    expect(insertedSkills).toHaveLength(2);
    expect(insertedSkills[0]!.experience_id).toBe(EXP_ID_1);
    expect(insertedSkills[0]!.skill_raw).toBe('React.js');
    expect(insertedSkills[0]!.skill_id).toBe(REACT_ID);
    expect(insertedSkills[1]!.skill_raw).toBe('UncatalogedStuff');
    expect(insertedSkills[1]!.skill_id).toBeNull();
  });

  it('stitches each skill to its own parent experience when there are multiple', async () => {
    const insertedSkills: ExperienceSkillInsertRow[] = [];
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        source_variant: 'cv_primary',
        raw_output: rawOutputTwoExperiences(),
      }),
      insertExperiences: async (rows) => [
        { temp_key: rows[0]!.temp_key, id: EXP_ID_1 },
        { temp_key: rows[1]!.temp_key, id: EXP_ID_2 },
      ],
      insertExperienceSkills: async (rows) => {
        insertedSkills.push(...rows);
      },
    });

    const result = await deriveExperiences(EXTRACTION_ID, deps);
    expect(result.experiencesInserted).toBe(2);
    expect(insertedSkills).toHaveLength(2);
    // Skill 1 (React.js) belongs to exp A, skill 2 (UncatalogedStuff) to exp B.
    expect(insertedSkills[0]!.experience_id).toBe(EXP_ID_1);
    expect(insertedSkills[1]!.experience_id).toBe(EXP_ID_2);
  });

  it('stamps a real ISO timestamp on resolved_at for resolver hits; null for misses', async () => {
    const insertedSkills: ExperienceSkillInsertRow[] = [];
    const deps = makeDeps({
      insertExperienceSkills: async (rows) => {
        insertedSkills.push(...rows);
      },
    });

    await deriveExperiences(EXTRACTION_ID, deps);
    expect(insertedSkills[0]!.resolved_at).toBe('2026-04-20T12:00:00.000Z');
    expect(insertedSkills[1]!.resolved_at).toBeNull();
  });

  it('is idempotent: skips all writes when candidate_experiences already exist for extraction_id', async () => {
    const insertExperiences = vi.fn();
    const insertExperienceSkills = vi.fn();
    const deps = makeDeps({
      hasExistingExperiences: async () => true,
      insertExperiences,
      insertExperienceSkills,
    });

    const result = await deriveExperiences(EXTRACTION_ID, deps);
    expect(result.skipped).toBe(true);
    expect(result.experiencesInserted).toBe(0);
    expect(result.skillsInserted).toBe(0);
    expect(insertExperiences).not.toHaveBeenCalled();
    expect(insertExperienceSkills).not.toHaveBeenCalled();
  });

  it('throws when the extraction row is not found', async () => {
    const deps = makeDeps({
      loadExtraction: async () => null,
    });
    await expect(deriveExperiences(EXTRACTION_ID, deps)).rejects.toThrow(/extraction.*not found/i);
  });

  it('skips the skill insert call entirely when no experience has skills', async () => {
    const insertExperienceSkills = vi.fn();
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        source_variant: 'cv_primary',
        raw_output: {
          source_variant: 'cv_primary',
          experiences: [
            {
              kind: 'work',
              company: 'X',
              title: null,
              start_date: null,
              end_date: null,
              description: null,
              skills: [],
            },
          ],
          languages: [],
        },
      }),
      insertExperienceSkills,
    });

    const result = await deriveExperiences(EXTRACTION_ID, deps);
    expect(result.experiencesInserted).toBe(1);
    expect(result.skillsInserted).toBe(0);
    expect(insertExperienceSkills).not.toHaveBeenCalled();
  });

  it('does not call insertExperienceSkills for the empty case but still returns skillsInserted=0', async () => {
    let skillsCall = 0;
    const deps = makeDeps({
      loadExtraction: async () => ({
        candidate_id: CANDIDATE_ID,
        source_variant: 'cv_primary',
        raw_output: { source_variant: 'cv_primary', experiences: [], languages: [] },
      }),
      insertExperiences: async () => [],
      insertExperienceSkills: async () => {
        skillsCall += 1;
      },
    });

    const result = await deriveExperiences(EXTRACTION_ID, deps);
    expect(result.experiencesInserted).toBe(0);
    expect(result.skillsInserted).toBe(0);
    expect(skillsCall).toBe(0);
  });
});
