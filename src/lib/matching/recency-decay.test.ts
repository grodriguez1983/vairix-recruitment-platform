/**
 * Unit tests for `effectiveYearsForSkill()` + helpers (ADR-026).
 *
 * The decay is a multiplicative factor applied on top of `yearsForSkill`
 * (ADR-015 + ADR-020). It is driven by:
 *   - the latest end_date of any work or side_project experience that
 *     mentions the resolved skill (`lastUsed`),
 *   - a uniform half-life (`HALF_LIFE_YEARS = 4`),
 *   - an `asOf` date provided by the caller (no wallclock default —
 *     determinism is part of the API contract).
 *
 * These tests target the contract, not the internals: the math is
 * checked through `effectiveYearsForSkill` end-to-end.
 */
import { describe, expect, it } from 'vitest';

import { HALF_LIFE_YEARS, decayFactor, effectiveYearsForSkill, lastUsedFor } from './recency-decay';
import type { ExperienceKind, ExperienceSkill, MergedExperience } from './types';

const JAVA_ID = '00000000-0000-0000-0000-00000000000a';
const REACT_ID = '00000000-0000-0000-0000-00000000000b';

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

const NOW = new Date('2026-04-27T00:00:00Z');

describe('decayFactor — ADR-026', () => {
  it('test_decay_factor_one_when_used_today', () => {
    expect(decayFactor(0)).toBe(1);
  });

  it('test_decay_factor_half_at_one_half_life', () => {
    // 4 years since last use, half-life 4 → 0.5 exactly.
    expect(decayFactor(HALF_LIFE_YEARS)).toBeCloseTo(0.5, 6);
  });

  it('test_decay_factor_quarter_at_two_half_lives', () => {
    expect(decayFactor(HALF_LIFE_YEARS * 2)).toBeCloseTo(0.25, 6);
  });

  it('test_decay_factor_clamped_when_negative_input', () => {
    // Future-dated lastUsed (data bug) → no decay.
    expect(decayFactor(-3)).toBe(1);
  });

  it('test_decay_factor_respects_custom_half_life', () => {
    expect(decayFactor(2, 2)).toBeCloseTo(0.5, 6); // half-life 2 → 0.5 at 2y
  });
});

describe('lastUsedFor — ADR-026', () => {
  it('test_last_used_picks_max_end_date_across_experiences', () => {
    const a = mkExp({
      id: 'a',
      start: '2005-01-01',
      end: '2010-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2018-01-01',
      end: '2020-06-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const result = lastUsedFor(JAVA_ID, [a, b], NOW);
    expect(result?.toISOString().slice(0, 10)).toBe('2020-06-01');
  });

  it('test_last_used_treats_null_end_date_as_asOf', () => {
    const ongoing = mkExp({
      id: 'a',
      start: '2024-01-01',
      end: null,
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const result = lastUsedFor(JAVA_ID, [ongoing], NOW);
    expect(result?.getTime()).toBe(NOW.getTime());
  });

  it('test_last_used_includes_side_project', () => {
    const oldWork = mkExp({
      id: 'w',
      kind: 'work',
      start: '2010-01-01',
      end: '2015-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const recentSide = mkExp({
      id: 's',
      kind: 'side_project',
      start: '2024-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const result = lastUsedFor(JAVA_ID, [oldWork, recentSide], NOW);
    expect(result?.toISOString().slice(0, 10)).toBe('2025-01-01');
  });

  it('test_last_used_excludes_education', () => {
    const courseOnly = mkExp({
      id: 'e',
      kind: 'education',
      start: '2024-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const oldWork = mkExp({
      id: 'w',
      kind: 'work',
      start: '2008-01-01',
      end: '2010-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const result = lastUsedFor(JAVA_ID, [courseOnly, oldWork], NOW);
    expect(result?.toISOString().slice(0, 10)).toBe('2010-01-01');
  });

  it('test_last_used_returns_null_when_skill_absent', () => {
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    expect(lastUsedFor(JAVA_ID, [exp], NOW)).toBeNull();
  });

  it('test_last_used_ignores_unresolved_skill_id', () => {
    // skill_raw matches but skill_id is null — catalog is the source of
    // truth (consistent with yearsForSkill's contract).
    const exp = mkExp({
      id: 'a',
      start: '2024-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: null, skill_raw: 'Java' }],
    });
    expect(lastUsedFor(JAVA_ID, [exp], NOW)).toBeNull();
  });
});

describe('effectiveYearsForSkill — ADR-026', () => {
  it('test_decay_penalizes_15yr_old_java — 5 raw years from 2005-2010 → ~0.36 effective at 2026', () => {
    // Owner's canonical case: 5 years of Java between 2005-01-01 and
    // 2010-01-01. asOf = 2026-04-27. lastUsed = 2010-01-01 → ~16.32y
    // since last use. decayFactor = 0.5^(16.32/4) ≈ 0.0589. Effective
    // years ≈ 5 × 0.0589 ≈ 0.29. (The exact number depends on date
    // arithmetic; the assertion checks the order of magnitude.)
    const exp = mkExp({
      id: 'a',
      start: '2005-01-01',
      end: '2010-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const r = effectiveYearsForSkill(JAVA_ID, [exp], { asOf: NOW });
    expect(r.rawYears).toBeCloseTo(5, 1);
    expect(r.effectiveYears).toBeGreaterThan(0.2);
    expect(r.effectiveYears).toBeLessThan(0.5);
    expect(r.decayFactor).toBeLessThan(0.1);
    expect(r.lastUsed?.toISOString().slice(0, 10)).toBe('2010-01-01');
    expect(r.yearsSinceLastUse).toBeGreaterThan(15);
    expect(r.yearsSinceLastUse).toBeLessThan(17);
  });

  it('test_decay_preserves_ongoing_experience — end_date=null → factor 1', () => {
    const ongoing = mkExp({
      id: 'a',
      start: '2024-01-01',
      end: null,
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const r = effectiveYearsForSkill(JAVA_ID, [ongoing], { asOf: NOW });
    expect(r.decayFactor).toBe(1);
    expect(r.effectiveYears).toBeCloseTo(r.rawYears, 6);
    expect(r.lastUsed?.getTime()).toBe(NOW.getTime());
  });

  it('test_decay_uses_asOf_not_wallclock — same inputs, different asOf, different decay', () => {
    const exp = mkExp({
      id: 'a',
      start: '2005-01-01',
      end: '2010-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const r2014 = effectiveYearsForSkill(JAVA_ID, [exp], {
      asOf: new Date('2014-01-01T00:00:00Z'),
    });
    const r2026 = effectiveYearsForSkill(JAVA_ID, [exp], { asOf: NOW });
    // 2014: 4y since last use → factor 0.5
    // 2026: ~16y since last use → factor << 0.1
    expect(r2014.decayFactor).toBeCloseTo(0.5, 2);
    expect(r2026.decayFactor).toBeLessThan(0.1);
    expect(r2014.effectiveYears).toBeGreaterThan(r2026.effectiveYears);
  });

  it('test_decay_uses_latest_end_date_per_skill — Java 2005-2010 + 2018-2020 anchors at 2020', () => {
    // 5 years 2005-2010 (work) + 2 years 2018-2020 (work). Sweep-line
    // merges to 7 raw years (disjoint). lastUsed = 2020-01-01.
    // From 2026-04-27, ~6.32y elapsed → factor 0.5^(6.32/4) ≈ 0.335.
    const a = mkExp({
      id: 'a',
      start: '2005-01-01',
      end: '2010-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const b = mkExp({
      id: 'b',
      start: '2018-01-01',
      end: '2020-01-01',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const r = effectiveYearsForSkill(JAVA_ID, [a, b], { asOf: NOW });
    expect(r.lastUsed?.toISOString().slice(0, 10)).toBe('2020-01-01');
    expect(r.rawYears).toBeCloseTo(7, 1);
    expect(r.decayFactor).toBeGreaterThan(0.3);
    expect(r.decayFactor).toBeLessThan(0.4);
    expect(r.effectiveYears).toBeGreaterThan(2.0);
    expect(r.effectiveYears).toBeLessThan(2.5);
  });

  it('test_decay_compounds_with_side_project_weight_ortogonally', () => {
    // ADR-020: side_project weighted at 0.25. ADR-026: decay applies
    // to the post-weight raw value. They must compose without
    // double-counting.
    const recentSide = mkExp({
      id: 's',
      kind: 'side_project',
      start: '2025-04-27',
      end: null, // ongoing → no decay
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const r = effectiveYearsForSkill(JAVA_ID, [recentSide], { asOf: NOW });
    // 1 year × 0.25 = 0.25 raw. Ongoing → factor 1. Effective = 0.25.
    expect(r.rawYears).toBeCloseTo(0.25, 2);
    expect(r.decayFactor).toBe(1);
    expect(r.effectiveYears).toBeCloseTo(0.25, 2);
  });

  it('test_decay_returns_zero_effective_when_skill_absent', () => {
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2022-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const r = effectiveYearsForSkill(JAVA_ID, [exp], { asOf: NOW });
    expect(r.rawYears).toBe(0);
    expect(r.effectiveYears).toBe(0);
    expect(r.lastUsed).toBeNull();
    // Convention: no experience → factor is 1 (no penalty applied to 0).
    expect(r.decayFactor).toBe(1);
  });

  it('test_decay_clamped_when_lastUsed_in_future_data_bug', () => {
    // Data bug: experience claims to end in the future relative to asOf.
    // We must not blow up; treat as no decay (factor 1).
    const exp = mkExp({
      id: 'a',
      start: '2025-01-01',
      end: '2027-01-01', // after NOW (2026-04-27)
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    const r = effectiveYearsForSkill(JAVA_ID, [exp], { asOf: NOW });
    expect(r.decayFactor).toBe(1);
    expect(r.yearsSinceLastUse).toBe(0);
  });

  it('test_decay_factor_at_exact_half_life — 4 years since last use → 0.5', () => {
    const exp = mkExp({
      id: 'a',
      start: '2018-04-27',
      end: '2022-04-27',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    // lastUsed = 2022-04-27, asOf = 2026-04-27 → exactly 4 years.
    const r = effectiveYearsForSkill(JAVA_ID, [exp], { asOf: NOW });
    expect(r.yearsSinceLastUse).toBeCloseTo(4, 2);
    expect(r.decayFactor).toBeCloseTo(0.5, 3);
    expect(r.effectiveYears).toBeCloseTo(r.rawYears * 0.5, 2);
  });

  it('test_decay_accepts_custom_half_life_per_call', () => {
    const exp = mkExp({
      id: 'a',
      start: '2018-04-27',
      end: '2022-04-27',
      skills: [{ skill_id: JAVA_ID, skill_raw: 'Java' }],
    });
    // With half-life 2 (instead of 4), 4 years elapsed → factor 0.25.
    const r = effectiveYearsForSkill(JAVA_ID, [exp], { asOf: NOW, halfLifeYears: 2 });
    expect(r.decayFactor).toBeCloseTo(0.25, 3);
  });
});
