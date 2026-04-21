/**
 * Unit tests for `yearsForSkill()` (ADR-015 §1, F4-007 sub-B).
 *
 * Sweep-line merge of experience intervals for a given skill. Only
 * `kind='work'` contributes — `side_project` and `education` are
 * excluded per ADR. Experiences with unresolved skills
 * (`skill_id === null`) never contribute even if `skill_raw` matches
 * the requirement's literal string.
 *
 * Tests 1–6 below map 1:1 to ADR-015 §Tests Requeridos.
 */
import { describe, expect, it } from 'vitest';

import type { MergedExperience, ExperienceSkill, ExperienceKind } from './types';
import { yearsForSkill } from './years-calculator';

const REACT_ID = '00000000-0000-0000-0000-000000000001';
const NODE_ID = '00000000-0000-0000-0000-000000000002';

function mkExp(params: {
  id: string;
  kind?: ExperienceKind;
  start: string | null;
  end: string | null;
  skills: ExperienceSkill[];
}): MergedExperience {
  return {
    id: params.id,
    source_variant: 'cv_primary',
    kind: params.kind ?? 'work',
    company: 'Acme',
    title: 'Engineer',
    start_date: params.start,
    end_date: params.end,
    description: null,
    skills: params.skills,
    merged_from_ids: [params.id],
  };
}

const NOW = new Date('2025-01-01T00:00:00Z');

describe('yearsForSkill — ADR-015 §1', () => {
  it('test_single_skill_single_experience_exact_match — 3 year span returns ~3', () => {
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [exp], { now: NOW });
    expect(y).toBeCloseTo(3, 1);
  });

  it('test_overlapping_experiences_merged_not_summed — 2020-2022 + 2021-2023 = 3y, not 4', () => {
    const a = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2021-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [a, b], { now: NOW });
    expect(y).toBeCloseTo(3, 1);
  });

  it('test_gap_in_experiences_counted_correctly — 2018-2020 + 2023-2024 = 3y', () => {
    const a = mkExp({
      id: 'a',
      start: '2018-01-01',
      end: '2020-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2023-01-01',
      end: '2024-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [a, b], { now: NOW });
    expect(y).toBeCloseTo(3, 1);
  });

  it('test_side_project_excluded_from_years — kind=side_project → 0', () => {
    const exp = mkExp({
      id: 'a',
      kind: 'side_project',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    expect(yearsForSkill(REACT_ID, [exp], { now: NOW })).toBe(0);
  });

  it('test_education_excluded_from_years — kind=education → 0', () => {
    const exp = mkExp({
      id: 'a',
      kind: 'education',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    expect(yearsForSkill(REACT_ID, [exp], { now: NOW })).toBe(0);
  });

  it('test_unresolved_skill_does_not_contribute — skill_id=null never counts', () => {
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: null, skill_raw: 'React' }],
    });
    // Even though skill_raw matches, skill_id is null → no contribution.
    expect(yearsForSkill(REACT_ID, [exp], { now: NOW })).toBe(0);
  });

  // Adversarials

  it('experience with null start_date is skipped, not errored', () => {
    const a = mkExp({
      id: 'a',
      start: null,
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2020-01-01',
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [a, b], { now: NOW });
    expect(y).toBeCloseTo(2, 1);
  });

  it('end_date = null is treated as now (present)', () => {
    const exp = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: null,
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [exp], { now: NOW });
    expect(y).toBeCloseTo(2, 1); // 2023-01-01 → 2025-01-01 = 2 years
  });

  it('returns 0 when no experiences mention the requested skill_id', () => {
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: NODE_ID, skill_raw: 'Node.js' }],
    });
    expect(yearsForSkill(REACT_ID, [exp], { now: NOW })).toBe(0);
  });

  it('contiguous intervals (end = start) collapse into one continuous span', () => {
    const a = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2021-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2021-01-01',
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [a, b], { now: NOW });
    expect(y).toBeCloseTo(2, 1);
  });

  it('experience end <= start is filtered out (data bug protection)', () => {
    const bad = mkExp({
      id: 'a',
      start: '2022-01-01',
      end: '2020-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    expect(yearsForSkill(REACT_ID, [bad], { now: NOW })).toBe(0);
  });

  it('same skill in two unrelated experiences sums disjoint spans', () => {
    const a = mkExp({
      id: 'a',
      start: '2015-01-01',
      end: '2017-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [a, b], { now: NOW });
    expect(y).toBeCloseTo(5, 1); // 2 + 3
  });

  it('multiple overlapping intervals collapse into a single merged range', () => {
    const a = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2021-06-01',
      end: '2023-06-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const c = mkExp({
      id: 'c',
      start: '2022-06-01',
      end: '2024-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const y = yearsForSkill(REACT_ID, [a, b, c], { now: NOW });
    expect(y).toBeCloseTo(4, 1); // 2020-01-01 → 2024-01-01
  });
});
