/**
 * Unit tests for `aggregateScore()` (ADR-015 §3, F4-007 sub-C).
 *
 * Tests 7–11 from the ADR + adversarials that exercise the must-have
 * gate, null min_years, language bonus/penalty, seniority match,
 * normalization, evidence population, and full-match score 100.
 */
import { describe, expect, it } from 'vitest';

import type {
  ResolvedDecomposition,
  ResolvedRequirement,
} from '../rag/decomposition/resolve-requirements';

import { aggregateScore } from './score-aggregator';
import type { CandidateAggregate, MergedExperience, ExperienceSkill } from './types';

const REACT_ID = '00000000-0000-0000-0000-000000000001';
const TS_ID = '00000000-0000-0000-0000-000000000002';
const AWS_ID = '00000000-0000-0000-0000-000000000003';
const KUBE_ID = '00000000-0000-0000-0000-000000000004';
const TAILWIND_ID = '00000000-0000-0000-0000-000000000005';
const STYLED_ID = '00000000-0000-0000-0000-000000000006';

const NOW = new Date('2025-01-01T00:00:00Z');

function mkRequirement(
  overrides: Partial<ResolvedRequirement> & { skill_raw: string },
): ResolvedRequirement {
  return {
    skill_raw: overrides.skill_raw,
    skill_id: overrides.skill_id ?? null,
    resolved_at: overrides.resolved_at ?? null,
    min_years: overrides.min_years ?? null,
    max_years: overrides.max_years ?? null,
    must_have: overrides.must_have ?? false,
    evidence_snippet: overrides.evidence_snippet ?? 'x',
    category: overrides.category ?? 'technical',
    alternative_group_id: overrides.alternative_group_id ?? null,
  };
}

function mkJobQuery(overrides: Partial<ResolvedDecomposition> = {}): ResolvedDecomposition {
  return {
    requirements: overrides.requirements ?? [],
    seniority: overrides.seniority ?? 'unspecified',
    languages: overrides.languages ?? [],
    notes: overrides.notes ?? null,
    role_essentials: overrides.role_essentials ?? [],
  };
}

function mkExp(params: {
  id: string;
  start: string | null;
  end: string | null;
  skills: ExperienceSkill[];
  company?: string;
  kind?: 'work' | 'side_project' | 'education';
}): MergedExperience {
  return {
    id: params.id,
    source_variant: 'cv_primary',
    kind: params.kind ?? 'work',
    company: params.company ?? 'Acme',
    title: 'Engineer',
    start_date: params.start,
    end_date: params.end,
    description: null,
    skills: params.skills,
    merged_from_ids: [params.id],
  };
}

function mkCandidate(
  overrides: Partial<CandidateAggregate> & { candidate_id: string },
): CandidateAggregate {
  return {
    candidate_id: overrides.candidate_id,
    merged_experiences: overrides.merged_experiences ?? [],
    languages: overrides.languages ?? [],
  };
}

describe('aggregateScore — ADR-015 §3', () => {
  it('test_single_skill_single_experience_exact_match — React 3+ with 3y → score 100 passed', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 3, must_have: true }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('passed');
    expect(result.total_score).toBeCloseTo(100, 0);
    expect(result.breakdown).toHaveLength(1);
    expect(result.breakdown[0]!.status).toBe('match');
    expect(result.breakdown[0]!.evidence).toHaveLength(1);
    expect(result.breakdown[0]!.evidence[0]!.company).toBe('Acme');
  });

  it('test_must_have_failed_candidate_in_separate_section — missing must-have → gate failed, score 0', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 3, must_have: true }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: TS_ID, skill_raw: 'TypeScript' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('failed');
    expect(result.total_score).toBe(0);
    expect(result.breakdown[0]!.status).toBe('missing');
  });

  it('test_min_years_null_boolean_presence — min_years=null, presence → ratio 1.0; absence → 0', () => {
    const reqsPresent = [
      mkRequirement({ skill_raw: 'AWS', skill_id: AWS_ID, min_years: null, must_have: false }),
    ];
    const expPresent = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: '2024-01-01',
      skills: [{ skill_id: AWS_ID, skill_raw: 'AWS' }],
    });
    const presence = aggregateScore(
      mkJobQuery({ requirements: reqsPresent }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [expPresent] }),
      { now: NOW },
    );
    expect(presence.breakdown[0]!.years_ratio).toBe(1);
    expect(presence.breakdown[0]!.status).toBe('match');

    const absence = aggregateScore(
      mkJobQuery({ requirements: reqsPresent }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [] }),
      { now: NOW },
    );
    expect(absence.breakdown[0]!.years_ratio).toBe(0);
    expect(absence.breakdown[0]!.status).toBe('missing');
  });

  it('test_language_bonus_applied — all required languages matched → +5', () => {
    // Partial ratio (1y vs min 2y → base 50) so the +5 bonus is visible
    // and not clipped by the 100 ceiling.
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 2, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: '2024-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const withBonus = aggregateScore(
      mkJobQuery({
        requirements: reqs,
        languages: [
          { name: 'English', level: 'advanced', must_have: false },
          { name: 'Spanish', level: 'native', must_have: false },
        ],
      }),
      mkCandidate({
        candidate_id: 'c',
        merged_experiences: [exp],
        languages: [
          { name: 'English', level: 'advanced' },
          { name: 'Spanish', level: 'native' },
        ],
      }),
      { now: NOW },
    );
    const withoutLanguages = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    // Same base score, bonus adds 5 clamped.
    expect(withBonus.total_score - withoutLanguages.total_score).toBe(5);
    expect(withBonus.language_match).toEqual({ required: 2, matched: 2 });
  });

  it('test_language_missing_must_have_penalty — missing must_have language → -10', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 1, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: '2024-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({
        requirements: reqs,
        languages: [{ name: 'German', level: 'advanced', must_have: true }],
      }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp], languages: [] }),
      { now: NOW },
    );
    const baseline = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp], languages: [] }),
      { now: NOW },
    );
    expect(baseline.total_score - result.total_score).toBe(10);
    expect(result.language_match).toEqual({ required: 1, matched: 0 });
  });

  it('test_seniority_match_adjustment — candidate seniority matches job query → +5', () => {
    // Job asks senior; candidate has 6 years of work → senior bucket.
    // Partial skill ratio (6y vs 12y → base 50) so the +5 bonus is not
    // swallowed by the ceiling clamp.
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 12, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2019-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const match = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    const noSeniority = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'unspecified' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(match.seniority_match).toBe('match');
    expect(match.total_score - noSeniority.total_score).toBe(5);
  });

  it('seniority mismatch (asks senior, candidate junior) → -5, seniority_match=below', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 1, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2024-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    const noSeniority = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'unspecified' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.seniority_match).toBe('below');
    expect(noSeniority.total_score - result.total_score).toBe(5);
  });

  it('test_seniority_above_symmetric_with_match — overqualified candidate gets +5, same as match (ADR-023)', () => {
    // ADR-023: `above` used to return 0 delta while `match` returned
    // +5, which made the most senior candidates rank below moderately
    // senior ones (incident 2026-04-23, job_query ccfd19d3-...). Fix:
    // `above` is treated as a positive signal equivalent to `match`.
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 24, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2013-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    // 12 years of React (base ratio 12/24 = 0.5 → base score 50, so
    // the ±5 delta isn't swallowed by the clamp). Total work = 12y →
    // `lead` bucket; job asks `senior` → candidate is `above`.
    const above = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    const noSeniority = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'unspecified' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(above.seniority_match).toBe('above');
    expect(above.total_score - noSeniority.total_score).toBe(5);
  });

  // Adversarials.

  it('partial match on min_years yields partial status and proportional contribution', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'AWS', skill_id: AWS_ID, min_years: 4, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: AWS_ID, skill_raw: 'AWS' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.breakdown[0]!.years_ratio).toBeCloseTo(0.5, 1);
    expect(result.breakdown[0]!.status).toBe('partial');
  });

  it('must-have with min_years=null and absent skill → gate failed', () => {
    // ADR-015 §3.1 gate rule: if must_have min_years > 0 and years = 0.
    // min_years=null means "presence check"; absence is still missing.
    // Gate is triggered when must_have is not satisfied (ratio=0).
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: null, must_have: true }),
    ];
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('failed');
    expect(result.total_score).toBe(0);
  });

  it('empty requirements list → score 0 and gate passed (no must-haves to fail)', () => {
    const result = aggregateScore(
      mkJobQuery({ requirements: [] }),
      mkCandidate({ candidate_id: 'c' }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('passed');
    expect(result.total_score).toBe(0);
    expect(result.breakdown).toHaveLength(0);
  });

  it('weights differ: must-have (2.0) vs nice-to-have (1.0) drive normalization', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 1, must_have: true }),
      mkRequirement({ skill_raw: 'Kube', skill_id: KUBE_ID, min_years: 1, must_have: false }),
    ];
    // Only nice-to-have satisfied. Should score must_have failed = 0.
    const expKube = mkExp({
      id: 'k',
      start: '2023-01-01',
      end: '2024-06-01',
      skills: [{ skill_id: KUBE_ID, skill_raw: 'Kube' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [expKube] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('failed');
    expect(result.total_score).toBe(0);
  });

  it('unresolved requirement (skill_id null) contributes 0 but does not fail gate', () => {
    // Edge: an ADR-013 mishap means the LLM asked for 'Kustomize' but
    // the catalog didn't have it. skill_id=null → nobody can match it.
    // Per ADR-015 §Consecuencias: gate should NOT fail here (otherwise
    // catalog drift silently hides candidates). We still record the
    // row as missing in breakdown.
    const reqs = [
      mkRequirement({ skill_raw: 'Kustomize', skill_id: null, min_years: 2, must_have: true }),
    ];
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('passed');
    expect(result.breakdown[0]!.status).toBe('missing');
    expect(result.breakdown[0]!.candidate_years).toBe(0);
  });

  // ----------------------------------------------------------
  // ADR-021: alternative_group_id. Alternatives in an OR group
  // collapse to a single contribution (max of alternatives) with
  // one group's weight (not N×weight). The gate fails only if NO
  // alternative in the group is satisfied.
  // ----------------------------------------------------------

  it('OR group must-have: covering one alternative passes the gate', () => {
    // g-css = {Tailwind, styled-components}, both must_have, min_years=1.
    // Candidate has styled-components for 2 years, no Tailwind.
    // Pre-21 behavior: Tailwind's must-have row has years_ratio=0 → gate fails.
    // Post-21 behavior: the group is covered by styled-components → gate passes.
    const reqs = [
      mkRequirement({
        skill_raw: 'Tailwind',
        skill_id: TAILWIND_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
      mkRequirement({
        skill_raw: 'styled-components',
        skill_id: STYLED_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: STYLED_ID, skill_raw: 'styled-components' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('passed');
  });

  it('OR group must-have: group weight = one alternative (max contribution)', () => {
    // One OR group with two alternatives vs one singleton must-have.
    // Candidate fully satisfies both: score should be 100, not less,
    // because the group weight must match a single must-have (2.0).
    // If the group weight were 2×2=4, the singleton's contribution
    // would be undernormalized relative to the group.
    const reqs = [
      mkRequirement({
        skill_raw: 'React',
        skill_id: REACT_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: null,
      }),
      mkRequirement({
        skill_raw: 'Tailwind',
        skill_id: TAILWIND_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
      mkRequirement({
        skill_raw: 'styled-components',
        skill_id: STYLED_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2025-01-01',
      skills: [
        { skill_id: REACT_ID, skill_raw: 'React' },
        { skill_id: TAILWIND_ID, skill_raw: 'Tailwind' },
        { skill_id: STYLED_ID, skill_raw: 'styled-components' },
      ],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('passed');
    expect(result.total_score).toBe(100);
  });

  it('OR group: gate fails only when NO resolved alternative is satisfied', () => {
    // Both alternatives resolved, candidate has neither → gate fails.
    const reqs = [
      mkRequirement({
        skill_raw: 'Tailwind',
        skill_id: TAILWIND_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
      mkRequirement({
        skill_raw: 'styled-components',
        skill_id: STYLED_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
    ];
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('failed');
  });

  it('OR group: unresolved alternatives alongside a resolved one do not fail the gate', () => {
    // Group has one resolved (Tailwind) + one unresolved (styled-components,
    // skill_id=null). Candidate has Tailwind with years → gate passes, and
    // the unresolved row does NOT pull down the score (it's collapsed into
    // the group's max contribution, which is Tailwind's).
    const reqs = [
      mkRequirement({
        skill_raw: 'Tailwind',
        skill_id: TAILWIND_ID,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
      mkRequirement({
        skill_raw: 'styled-components',
        skill_id: null,
        min_years: 1,
        must_have: true,
        alternative_group_id: 'g-css',
      }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2022-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: TAILWIND_ID, skill_raw: 'Tailwind' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.must_have_gate).toBe('passed');
    expect(result.total_score).toBe(100);
  });

  it('total score is clamped to [0, 100] after bonuses', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 1, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2019-01-01',
      end: '2025-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({
        requirements: reqs,
        seniority: 'senior',
        languages: [{ name: 'English', level: 'advanced', must_have: false }],
      }),
      mkCandidate({
        candidate_id: 'c',
        merged_experiences: [exp],
        languages: [{ name: 'English', level: 'advanced' }],
      }),
      { now: NOW },
    );
    // Full match 100 + lang bonus 5 + seniority bonus 5 = 110 → clamp 100.
    expect(result.total_score).toBe(100);
  });
});

/**
 * ADR-022 — Seniority-derived `min_years` baseline.
 *
 * Context (Bloque 12, 2026-04-23): a Senior JD that lists its stack
 * without explicit "X+ años" phrases produces requirements with
 * `min_years: null` across the board. Under the legacy binary
 * fallback (`ratio = years > 0 ? 1 : 0`) a candidate with 4 months
 * of React scores identically to one with 7 years. The fix: when
 * `min_years` is null AND the JD carries a concrete seniority, the
 * scorer uses the seniority's canonical baseline (junior=1,
 * semi_senior=2, senior=3, lead=5) as the denominator; otherwise
 * it keeps the binary fallback (no seniority signal ⇒ no justified
 * baseline).
 */
describe('aggregateScore — ADR-022 seniority-derived min_years baseline', () => {
  it('test_seniority_senior_null_min_years_uses_three_year_baseline — 1y/3y baseline → ratio ≈ 0.33', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: null, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2024-01-01',
      end: '2025-01-01', // exactly 1y against NOW=2025-01-01
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    // 1y / 3y baseline ≈ 0.333. Under the legacy binary this is 1.0.
    expect(result.breakdown[0]!.years_ratio).toBeCloseTo(1 / 3, 2);
    expect(result.breakdown[0]!.status).toBe('partial');
  });

  it('test_seniority_lead_null_min_years_uses_five_year_baseline — 2y/5y baseline → ratio = 0.4', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: null, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2023-01-01',
      end: '2025-01-01', // 2y against NOW=2025-01-01
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'lead' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.breakdown[0]!.years_ratio).toBeCloseTo(0.4, 2);
    expect(result.breakdown[0]!.status).toBe('partial');
  });

  it('test_seniority_senior_null_min_years_saturates_above_baseline — 5y/3y baseline → ratio = 1', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: null, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2020-01-01',
      end: '2025-01-01', // 5y
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.breakdown[0]!.years_ratio).toBe(1);
    expect(result.breakdown[0]!.status).toBe('match');
  });

  it('test_seniority_unspecified_keeps_binary_null_behavior — 4m + unspecified → ratio = 1 (regression guard)', () => {
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: null, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2024-09-01',
      end: '2025-01-01', // ~4 months
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'unspecified' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    // No seniority signal ⇒ binary presence stays in effect.
    expect(result.breakdown[0]!.years_ratio).toBe(1);
    expect(result.breakdown[0]!.status).toBe('match');
  });

  it('test_explicit_min_years_wins_over_seniority_default — senior + min_years=1 + 1.5y → ratio = 1 (regression guard)', () => {
    // The JD that DOES specify per-skill years must not be second-
    // guessed by the seniority default; regression guard.
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: 1, must_have: false }),
    ];
    const exp = mkExp({
      id: 'a',
      start: '2023-07-01',
      end: '2025-01-01', // 1.5y
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const result = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'c', merged_experiences: [exp] }),
      { now: NOW },
    );
    expect(result.breakdown[0]!.years_ratio).toBe(1);
    expect(result.breakdown[0]!.status).toBe('match');
  });

  it('test_seniority_derived_baseline_lucas_vs_hernan_scenario — 4m-React junior loses to 7y-React senior under Senior JD', () => {
    // Mirrors the 2026-04-23 prod incident (job_query 2d4d6faa):
    // a Senior JD with every requirement `min_years: null` ranked
    // Lucas Pereyra (0.34y React) above Hernán Garzón (7.48y
    // React). Under ADR-022 the Senior baseline of 3y must collapse
    // Lucas's React contribution while keeping Hernán's at 1.0.
    const reqs = [
      mkRequirement({ skill_raw: 'React', skill_id: REACT_ID, min_years: null, must_have: false }),
    ];
    const lucasExp = mkExp({
      id: 'lucas',
      start: '2024-09-01',
      end: '2025-01-01', // 4 months
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const hernanExp = mkExp({
      id: 'hernan',
      start: '2017-07-01',
      end: '2025-01-01', // ~7.5y
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const lucas = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'lucas', merged_experiences: [lucasExp] }),
      { now: NOW },
    );
    const hernan = aggregateScore(
      mkJobQuery({ requirements: reqs, seniority: 'senior' }),
      mkCandidate({ candidate_id: 'hernan', merged_experiences: [hernanExp] }),
      { now: NOW },
    );
    expect(hernan.breakdown[0]!.years_ratio).toBe(1);
    expect(lucas.breakdown[0]!.years_ratio).toBeLessThan(0.5);
    // (seniority-match deltas are orthogonal; assert the base ratio
    // is what inverts the ranking, not the ±5 bonus.)
    expect(hernan.breakdown[0]!.contribution).toBeGreaterThan(lucas.breakdown[0]!.contribution);
  });
});
