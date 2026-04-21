/**
 * Unit tests for `mergeVariants()` (ADR-015 §2, F4-007 sub-A).
 *
 * Contract:
 *   - Input: `ExperienceInput[]` drawn from `candidate_experiences`
 *     for a single candidate. May contain rows from both variants.
 *   - Output: canonical `MergedExperience[]` with `cv_primary`
 *     authoritative for duplicates (same company + title norm + date
 *     overlap > 50%). Non-duplicates survive untouched.
 *   - Skills union — deduped by `skill_id` when set, else by
 *     `skill_raw` (case-insensitive).
 *   - Deterministic: order preserved by the stable sort key
 *     (start_date desc, then cv_primary before linkedin_export).
 *
 * The tests below cover ADR-015 tests 12–16 plus adversarials
 * (null fields, normalization edge cases, multiple candidates with
 * overlapping matches).
 */
import { describe, expect, it } from 'vitest';

import type { ExperienceInput } from './types';
import { mergeVariants } from './variant-merger';

function mkExp(overrides: Partial<ExperienceInput> & { id: string }): ExperienceInput {
  // Use `in` checks so explicit `null` overrides survive (critical for
  // tests asserting that null company/dates block merging).
  return {
    id: overrides.id,
    source_variant: 'source_variant' in overrides ? overrides.source_variant! : 'cv_primary',
    kind: 'kind' in overrides ? overrides.kind! : 'work',
    company: 'company' in overrides ? overrides.company! : 'Acme',
    title: 'title' in overrides ? overrides.title! : 'Engineer',
    start_date: 'start_date' in overrides ? overrides.start_date! : '2020-01-01',
    end_date: 'end_date' in overrides ? overrides.end_date! : '2022-01-01',
    description: 'description' in overrides ? overrides.description! : null,
    skills: 'skills' in overrides ? overrides.skills! : [],
  };
}

describe('mergeVariants — ADR-015 §2', () => {
  it('test_cv_primary_only_candidate — no linkedin_export leaves cv_primary untouched', () => {
    const input: ExperienceInput[] = [
      mkExp({ id: 'a', source_variant: 'cv_primary', company: 'Acme' }),
      mkExp({ id: 'b', source_variant: 'cv_primary', company: 'Globex' }),
    ];
    const { experiences, diagnostics } = mergeVariants(input);
    expect(experiences).toHaveLength(2);
    expect(experiences.map((e) => e.id).sort()).toEqual(['a', 'b']);
    expect(experiences.every((e) => e.merged_from_ids.length === 1)).toBe(true);
    expect(diagnostics).toHaveLength(0);
  });

  it('test_linkedin_only_candidate — no cv_primary leaves linkedin_export untouched', () => {
    const input: ExperienceInput[] = [
      mkExp({ id: 'a', source_variant: 'linkedin_export', company: 'Acme' }),
      mkExp({ id: 'b', source_variant: 'linkedin_export', company: 'Globex' }),
    ];
    const { experiences, diagnostics } = mergeVariants(input);
    expect(experiences).toHaveLength(2);
    expect(experiences.every((e) => e.source_variant === 'linkedin_export')).toBe(true);
    expect(diagnostics).toHaveLength(0);
  });

  it('test_duplicate_experience_cv_primary_wins_dates — cv_primary overrides linkedin fields on match', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'primary',
        source_variant: 'cv_primary',
        company: 'Acme',
        title: 'Senior Engineer',
        start_date: '2020-01-01',
        end_date: '2022-12-31',
        description: 'Led the payments platform.',
      }),
      mkExp({
        id: 'linkedin',
        source_variant: 'linkedin_export',
        company: 'Acme',
        title: 'Engineer', // different-but-normalizable
        start_date: '2019-06-01', // different date
        end_date: '2022-01-01',
        description: 'did stuff',
      }),
    ];
    const { experiences, diagnostics } = mergeVariants(input);
    expect(experiences).toHaveLength(1);
    const merged = experiences[0]!;
    expect(merged.id).toBe('primary');
    expect(merged.source_variant).toBe('cv_primary');
    expect(merged.start_date).toBe('2020-01-01');
    expect(merged.end_date).toBe('2022-12-31');
    expect(merged.title).toBe('Senior Engineer');
    expect(merged.description).toBe('Led the payments platform.');
    expect(merged.merged_from_ids.sort()).toEqual(['linkedin', 'primary']);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.kind).toBe('merged');
  });

  it('test_non_duplicate_experiences_unioned — 3 cv_primary + 5 distinct linkedin → 8 merged rows', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p1',
        source_variant: 'cv_primary',
        company: 'Acme',
        start_date: '2022-01-01',
        end_date: '2024-01-01',
      }),
      mkExp({
        id: 'p2',
        source_variant: 'cv_primary',
        company: 'Globex',
        start_date: '2020-01-01',
        end_date: '2022-01-01',
      }),
      mkExp({
        id: 'p3',
        source_variant: 'cv_primary',
        company: 'Initech',
        start_date: '2018-01-01',
        end_date: '2020-01-01',
      }),
      mkExp({
        id: 'l1',
        source_variant: 'linkedin_export',
        company: 'Umbrella',
        start_date: '2015-01-01',
        end_date: '2016-01-01',
      }),
      mkExp({
        id: 'l2',
        source_variant: 'linkedin_export',
        company: 'Vandelay',
        start_date: '2014-01-01',
        end_date: '2015-01-01',
      }),
      mkExp({
        id: 'l3',
        source_variant: 'linkedin_export',
        company: 'Hooli',
        start_date: '2013-01-01',
        end_date: '2014-01-01',
      }),
      mkExp({
        id: 'l4',
        source_variant: 'linkedin_export',
        company: 'Pied Piper',
        start_date: '2012-01-01',
        end_date: '2013-01-01',
      }),
      mkExp({
        id: 'l5',
        source_variant: 'linkedin_export',
        company: 'Massive Dynamic',
        start_date: '2011-01-01',
        end_date: '2012-01-01',
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(8);
    expect(experiences.every((e) => e.merged_from_ids.length === 1)).toBe(true);
  });

  it('test_duplicate_heuristic_threshold — overlap < 50% keeps experiences distinct', () => {
    // Primary 2020-2022 and linkedin 2021-06 → 2024. Overlap = 6 months,
    // shorter duration = 24 months → ratio = 0.25 < 0.5 → NO merge.
    const input: ExperienceInput[] = [
      mkExp({
        id: 'primary',
        source_variant: 'cv_primary',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2020-01-01',
        end_date: '2022-01-01',
      }),
      mkExp({
        id: 'linkedin',
        source_variant: 'linkedin_export',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2021-06-01',
        end_date: '2024-01-01',
      }),
    ];
    const { experiences, diagnostics } = mergeVariants(input);
    expect(experiences).toHaveLength(2);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.kind).toBe('kept_distinct_below_threshold');
  });

  // Adversarials.

  it('unions skills by skill_id preferring cv_primary first but keeping unique linkedin ones', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p',
        source_variant: 'cv_primary',
        skills: [
          { skill_id: 'react', skill_raw: 'React' },
          { skill_id: 'ts', skill_raw: 'TypeScript' },
        ],
      }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        skills: [
          { skill_id: 'react', skill_raw: 'React.js' }, // dupe by skill_id
          { skill_id: 'node', skill_raw: 'Node.js' }, // new
        ],
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(1);
    const ids = experiences[0]!.skills.map((s) => s.skill_id).sort();
    expect(ids).toEqual(['node', 'react', 'ts']);
  });

  it('unions unresolved skills (skill_id === null) by case-insensitive skill_raw', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p',
        source_variant: 'cv_primary',
        skills: [{ skill_id: null, skill_raw: 'Kustomize' }],
      }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        skills: [
          { skill_id: null, skill_raw: 'kustomize' }, // dupe case-insensitive
          { skill_id: null, skill_raw: 'Helm' }, // new
        ],
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(1);
    const raws = experiences[0]!.skills.map((s) => s.skill_raw).sort();
    expect(raws).toEqual(['Helm', 'Kustomize']);
  });

  it('null company on either side prevents merging (not enough signal)', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p',
        source_variant: 'cv_primary',
        company: null,
        title: 'Eng',
        start_date: '2020-01-01',
        end_date: '2021-01-01',
      }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        company: null,
        title: 'Eng',
        start_date: '2020-01-01',
        end_date: '2021-01-01',
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(2);
  });

  it('null dates on either side prevent merging (no overlap computable)', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p',
        source_variant: 'cv_primary',
        company: 'Acme',
        start_date: null,
        end_date: null,
      }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        company: 'Acme',
        start_date: '2020-01-01',
        end_date: '2021-01-01',
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(2);
  });

  it('null end_date treated as NOW for overlap ratio', () => {
    const now = new Date('2025-01-01T00:00:00Z');
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p',
        source_variant: 'cv_primary',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2022-01-01',
        end_date: null, // present
      }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2022-06-01',
        end_date: null, // present
      }),
    ];
    const { experiences, diagnostics } = mergeVariants(input, { now });
    expect(experiences).toHaveLength(1);
    expect(experiences[0]!.id).toBe('p');
    expect(diagnostics[0]!.kind).toBe('merged');
  });

  it('company normalization tolerates Inc., LLC, and punctuation differences', () => {
    const input: ExperienceInput[] = [
      mkExp({ id: 'p', source_variant: 'cv_primary', company: 'Acme, Inc.', title: 'Engineer' }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        company: 'Acme Inc',
        title: 'Engineer',
        start_date: '2020-01-01',
        end_date: '2022-01-01',
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(1);
  });

  it('is deterministic: same input → same output (ordered, merged_from_ids stable)', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'x',
        source_variant: 'cv_primary',
        company: 'Acme',
        start_date: '2020-01-01',
        end_date: '2022-01-01',
      }),
      mkExp({
        id: 'y',
        source_variant: 'linkedin_export',
        company: 'Acme',
        start_date: '2020-06-01',
        end_date: '2022-06-01',
      }),
      mkExp({
        id: 'z',
        source_variant: 'linkedin_export',
        company: 'Globex',
        start_date: '2018-01-01',
        end_date: '2019-01-01',
      }),
    ];
    const first = mergeVariants(input);
    const second = mergeVariants([...input].reverse());
    expect(JSON.stringify(first.experiences.map((e) => [e.id, e.merged_from_ids]))).toBe(
      JSON.stringify(second.experiences.map((e) => [e.id, e.merged_from_ids])),
    );
  });

  it('different kinds (work vs education) at same company do not merge', () => {
    const input: ExperienceInput[] = [
      mkExp({
        id: 'p',
        source_variant: 'cv_primary',
        kind: 'work',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2020-01-01',
        end_date: '2022-01-01',
      }),
      mkExp({
        id: 'l',
        source_variant: 'linkedin_export',
        kind: 'education',
        company: 'Acme',
        title: 'Engineer',
        start_date: '2020-01-01',
        end_date: '2022-01-01',
      }),
    ];
    const { experiences } = mergeVariants(input);
    expect(experiences).toHaveLength(2);
  });
});
