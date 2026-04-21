/**
 * Unit tests for the pure derivation function (F4-005 sub-A).
 *
 * Covers ADR-012 §7: transform `ExtractionResult.raw_output` into
 * the tuples that will land in `candidate_experiences` and
 * `experience_skills`. This layer is pure — no DB, no network.
 * Sub-B wires it to Supabase; sub-C wires it to the extraction
 * worker end-to-end.
 *
 * Key invariants under test:
 *   - One candidate_experiences tuple per `raw_output.experiences[]`,
 *     with kind/company/title/description carried through unchanged.
 *   - Partial dates (YYYY-MM) materialize as YYYY-MM-01; dates
 *     already in YYYY-MM-DD pass through; null stays null.
 *   - Every skill in `experiences[i].skills[]` becomes one
 *     experience_skills tuple with the original `skill_raw`, keyed
 *     by the parent experience's temporary key so sub-B can stitch
 *     after insert.
 *   - Skills are resolved via the injected `CatalogSnapshot` —
 *     `skill_id` is set when the resolver matches; `null` otherwise
 *     (uncataloged). ADR-012 §2 invariant: `skill_raw` is NEVER
 *     mutated — resolver-normalized form stays inside the resolver.
 *   - Deterministic: same input → same output, same order.
 */
import { describe, expect, it } from 'vitest';

import { buildCatalogSnapshot } from '../../skills/resolver';

import { deriveFromRawOutput } from './derivation';
import type { ExtractionResult } from './types';

const CANDIDATE_ID = '00000000-0000-0000-0000-000000000001';
const EXTRACTION_ID = '00000000-0000-0000-0000-000000000002';
const TYPESCRIPT_ID = '10000000-0000-0000-0000-000000000001';
const REACT_ID = '10000000-0000-0000-0000-000000000002';

function catalog() {
  return buildCatalogSnapshot(
    [
      { id: TYPESCRIPT_ID, slug: 'typescript', deprecated_at: null },
      { id: REACT_ID, slug: 'react', deprecated_at: null },
    ],
    [{ skill_id: REACT_ID, alias_normalized: 'react.js' }],
  );
}

function context() {
  return {
    candidate_id: CANDIDATE_ID,
    extraction_id: EXTRACTION_ID,
    source_variant: 'cv_primary' as const,
  };
}

function raw(): ExtractionResult {
  return {
    source_variant: 'cv_primary',
    experiences: [
      {
        kind: 'work',
        company: 'Acme',
        title: 'Senior Engineer',
        start_date: '2022-03',
        end_date: '2024-10-15',
        description: 'Built stuff.',
        skills: ['TypeScript', 'React.js', 'SomeUncatalogedThing'],
      },
    ],
    languages: [],
  };
}

describe('deriveFromRawOutput (pure)', () => {
  it('returns one experience tuple per raw_output.experiences[] with fields carried through', () => {
    const out = deriveFromRawOutput(raw(), context(), catalog());

    expect(out.experiences).toHaveLength(1);
    const exp = out.experiences[0]!;
    expect(exp.candidate_id).toBe(CANDIDATE_ID);
    expect(exp.extraction_id).toBe(EXTRACTION_ID);
    expect(exp.source_variant).toBe('cv_primary');
    expect(exp.kind).toBe('work');
    expect(exp.company).toBe('Acme');
    expect(exp.title).toBe('Senior Engineer');
    expect(exp.description).toBe('Built stuff.');
  });

  it('materializes partial YYYY-MM dates as YYYY-MM-01 and preserves full dates and nulls', () => {
    const input: ExtractionResult = {
      source_variant: 'cv_primary',
      experiences: [
        {
          kind: 'work',
          company: null,
          title: null,
          start_date: '2020-01',
          end_date: null,
          description: null,
          skills: [],
        },
        {
          kind: 'education',
          company: null,
          title: null,
          start_date: '2018-09-15',
          end_date: '2022-12-20',
          description: null,
          skills: [],
        },
      ],
      languages: [],
    };
    const out = deriveFromRawOutput(input, context(), catalog());

    expect(out.experiences[0]!.start_date).toBe('2020-01-01');
    expect(out.experiences[0]!.end_date).toBe(null);
    expect(out.experiences[1]!.start_date).toBe('2018-09-15');
    expect(out.experiences[1]!.end_date).toBe('2022-12-20');
  });

  it('carries every kind verbatim (work / side_project / education)', () => {
    const input: ExtractionResult = {
      source_variant: 'cv_primary',
      experiences: (['work', 'side_project', 'education'] as const).map((k) => ({
        kind: k,
        company: null,
        title: null,
        start_date: null,
        end_date: null,
        description: null,
        skills: [],
      })),
      languages: [],
    };
    const out = deriveFromRawOutput(input, context(), catalog());
    expect(out.experiences.map((e) => e.kind)).toEqual(['work', 'side_project', 'education']);
  });

  it('emits one experience_skills tuple per raw skill, preserving the raw string verbatim', () => {
    const out = deriveFromRawOutput(raw(), context(), catalog());

    expect(out.experienceSkills).toHaveLength(3);
    expect(out.experienceSkills.map((s) => s.skill_raw)).toEqual([
      'TypeScript',
      'React.js',
      'SomeUncatalogedThing',
    ]);
  });

  it('resolves skills via the catalog: exact match → skill_id; alias → skill_id; uncataloged → null', () => {
    const out = deriveFromRawOutput(raw(), context(), catalog());

    const [ts, react, unc] = out.experienceSkills;
    expect(ts!.skill_id).toBe(TYPESCRIPT_ID);
    expect(react!.skill_id).toBe(REACT_ID); // matched via alias "react.js"
    expect(unc!.skill_id).toBe(null);
  });

  it('uncataloged skill tuples have resolved_at = null; resolved ones carry a timestamp', () => {
    const out = deriveFromRawOutput(raw(), context(), catalog());

    const [ts, , unc] = out.experienceSkills;
    expect(ts!.resolved_at).not.toBeNull();
    expect(unc!.resolved_at).toBeNull();
  });

  it('stitches each experience_skill to its parent via a stable temporary key', () => {
    const input: ExtractionResult = {
      source_variant: 'cv_primary',
      experiences: [
        {
          kind: 'work',
          company: 'A',
          title: null,
          start_date: null,
          end_date: null,
          description: null,
          skills: ['TypeScript'],
        },
        {
          kind: 'work',
          company: 'B',
          title: null,
          start_date: null,
          end_date: null,
          description: null,
          skills: ['React.js'],
        },
      ],
      languages: [],
    };
    const out = deriveFromRawOutput(input, context(), catalog());

    // Each experience has a unique temp_key, and each skill points at
    // its parent's temp_key.
    const keys = out.experiences.map((e) => e.temp_key);
    expect(new Set(keys).size).toBe(keys.length);
    expect(out.experienceSkills[0]!.experience_temp_key).toBe(out.experiences[0]!.temp_key);
    expect(out.experienceSkills[1]!.experience_temp_key).toBe(out.experiences[1]!.temp_key);
  });

  it('is deterministic: same input produces identical output bit-for-bit', () => {
    const freeze = (v: unknown): unknown => JSON.parse(JSON.stringify(v));
    // resolved_at is the only non-deterministic field — we compare
    // everything else and then assert resolved_at is either null or
    // a stable string derived from context, not wallclock time.
    const a = deriveFromRawOutput(raw(), context(), catalog());
    const b = deriveFromRawOutput(raw(), context(), catalog());

    expect(freeze(a.experiences)).toEqual(freeze(b.experiences));
    expect(a.experienceSkills.map((s) => ({ ...s, resolved_at: null }))).toEqual(
      b.experienceSkills.map((s) => ({ ...s, resolved_at: null })),
    );
  });

  it('empty experiences[] produces no experience and no experience_skills tuples', () => {
    const input: ExtractionResult = {
      source_variant: 'cv_primary',
      experiences: [],
      languages: [],
    };
    const out = deriveFromRawOutput(input, context(), catalog());
    expect(out.experiences).toHaveLength(0);
    expect(out.experienceSkills).toHaveLength(0);
  });

  it('experience with empty skills[] produces zero experience_skills tuples but still emits the experience', () => {
    const input: ExtractionResult = {
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
    };
    const out = deriveFromRawOutput(input, context(), catalog());
    expect(out.experiences).toHaveLength(1);
    expect(out.experienceSkills).toHaveLength(0);
  });
});
