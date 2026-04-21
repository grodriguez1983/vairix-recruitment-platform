/**
 * Unit tests for `loadCandidateAggregates` (F4-008 sub-A).
 *
 * This loader sits between the DB and the `DeterministicRanker`. It
 * fans out the raw rows (experiences + experience_skills + languages)
 * per candidate, runs `mergeVariants` to collapse cv_primary +
 * linkedin_export pairs, and assembles `CandidateAggregate[]` — the
 * exact shape the ranker consumes (`types.ts`).
 *
 * All I/O is injected so the unit suite doesn't need Supabase. The
 * integration test (sub-D) exercises the real SQL path under RLS.
 */
import { describe, expect, it, vi } from 'vitest';

import { loadCandidateAggregates } from './load-candidate-aggregates';
import type {
  CandidateExperienceRow,
  CandidateLanguageRow,
  LoadCandidateAggregatesDeps,
} from './load-candidate-aggregates';

const REACT_ID = '00000000-0000-0000-0000-000000000001';
const NODE_ID = '00000000-0000-0000-0000-000000000002';

function mkExpRow(overrides: Partial<CandidateExperienceRow>): CandidateExperienceRow {
  return {
    candidate_id: overrides.candidate_id ?? 'cand-1',
    id: overrides.id ?? 'exp-1',
    source_variant: overrides.source_variant ?? 'cv_primary',
    kind: overrides.kind ?? 'work',
    company: overrides.company ?? 'Acme',
    title: overrides.title ?? 'Engineer',
    start_date: overrides.start_date ?? '2020-01-01',
    end_date: overrides.end_date ?? '2023-01-01',
    description: overrides.description ?? null,
    skills: overrides.skills ?? [{ skill_id: REACT_ID, skill_raw: 'React' }],
  };
}

function mkDeps(overrides: {
  experiences?: CandidateExperienceRow[];
  languages?: CandidateLanguageRow[];
}): LoadCandidateAggregatesDeps {
  return {
    loadExperiences: vi.fn(async () => overrides.experiences ?? []),
    loadLanguages: vi.fn(async () => overrides.languages ?? []),
  };
}

describe('loadCandidateAggregates — F4-008 sub-A', () => {
  it('empty candidate list → returns [] without calling deps', async () => {
    const deps = mkDeps({});
    const out = await loadCandidateAggregates([], deps);
    expect(out).toEqual([]);
    expect(deps.loadExperiences).not.toHaveBeenCalled();
    expect(deps.loadLanguages).not.toHaveBeenCalled();
  });

  it('single candidate with 1 experience → 1 aggregate with that experience', async () => {
    const deps = mkDeps({
      experiences: [mkExpRow({ candidate_id: 'cand-1', id: 'e1' })],
      languages: [],
    });
    const out = await loadCandidateAggregates(['cand-1'], deps);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidate_id).toBe('cand-1');
    expect(out[0]!.merged_experiences).toHaveLength(1);
    expect(out[0]!.merged_experiences[0]!.id).toBe('e1');
    expect(out[0]!.merged_experiences[0]!.skills).toEqual([
      { skill_id: REACT_ID, skill_raw: 'React' },
    ]);
    expect(out[0]!.languages).toEqual([]);
  });

  it('passes input candidateIds to loadExperiences and loadLanguages', async () => {
    const deps = mkDeps({ experiences: [], languages: [] });
    await loadCandidateAggregates(['a', 'b', 'c'], deps);
    expect(deps.loadExperiences).toHaveBeenCalledWith(['a', 'b', 'c']);
    expect(deps.loadLanguages).toHaveBeenCalledWith(['a', 'b', 'c']);
  });

  it('multiple candidates → groups rows by candidate_id, preserves input order', async () => {
    const deps = mkDeps({
      experiences: [
        mkExpRow({ candidate_id: 'bb', id: 'e-bb' }),
        mkExpRow({ candidate_id: 'aa', id: 'e-aa' }),
      ],
      languages: [
        { candidate_id: 'aa', name: 'English', level: 'B2' },
        { candidate_id: 'bb', name: 'Spanish', level: null },
      ],
    });
    const out = await loadCandidateAggregates(['aa', 'bb'], deps);
    expect(out.map((c) => c.candidate_id)).toEqual(['aa', 'bb']);
    expect(out[0]!.merged_experiences[0]!.id).toBe('e-aa');
    expect(out[0]!.languages).toEqual([{ name: 'English', level: 'B2' }]);
    expect(out[1]!.merged_experiences[0]!.id).toBe('e-bb');
    expect(out[1]!.languages).toEqual([{ name: 'Spanish', level: null }]);
  });

  it('candidate in input with no rows → aggregate with empty experiences + empty languages', async () => {
    const deps = mkDeps({ experiences: [], languages: [] });
    const out = await loadCandidateAggregates(['ghost'], deps);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidate_id).toBe('ghost');
    expect(out[0]!.merged_experiences).toEqual([]);
    expect(out[0]!.languages).toEqual([]);
  });

  it('cv_primary + linkedin_export overlapping → collapsed via mergeVariants', async () => {
    const deps = mkDeps({
      experiences: [
        mkExpRow({
          candidate_id: 'cand-1',
          id: 'p1',
          source_variant: 'cv_primary',
          company: 'Acme',
          title: 'Engineer',
          start_date: '2020-01-01',
          end_date: '2023-01-01',
          skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
        }),
        mkExpRow({
          candidate_id: 'cand-1',
          id: 'l1',
          source_variant: 'linkedin_export',
          company: 'Acme Inc',
          title: 'Engineer',
          start_date: '2020-01-01',
          end_date: '2023-01-01',
          skills: [{ skill_id: NODE_ID, skill_raw: 'Node.js' }],
        }),
      ],
      languages: [],
    });
    const out = await loadCandidateAggregates(['cand-1'], deps);
    expect(out).toHaveLength(1);
    expect(out[0]!.merged_experiences).toHaveLength(1);
    const exp = out[0]!.merged_experiences[0]!;
    expect(exp.merged_from_ids.sort()).toEqual(['l1', 'p1']);
    const skillIds = exp.skills.map((s) => s.skill_id).sort();
    expect(skillIds).toEqual([REACT_ID, NODE_ID].sort());
  });

  it('does not leak rows from other candidates', async () => {
    const deps = mkDeps({
      experiences: [
        mkExpRow({ candidate_id: 'cand-1', id: 'e1' }),
        mkExpRow({ candidate_id: 'cand-2', id: 'e2' }),
      ],
      languages: [
        { candidate_id: 'cand-1', name: 'English', level: 'B2' },
        { candidate_id: 'cand-2', name: 'Spanish', level: null },
      ],
    });
    const out = await loadCandidateAggregates(['cand-1'], deps);
    expect(out).toHaveLength(1);
    expect(out[0]!.candidate_id).toBe('cand-1');
    expect(out[0]!.merged_experiences).toHaveLength(1);
    expect(out[0]!.merged_experiences[0]!.id).toBe('e1');
    expect(out[0]!.languages).toEqual([{ name: 'English', level: 'B2' }]);
  });

  it('multiple languages per candidate preserved in order returned by loader', async () => {
    const deps = mkDeps({
      experiences: [],
      languages: [
        { candidate_id: 'cand-1', name: 'English', level: 'B2' },
        { candidate_id: 'cand-1', name: 'Spanish', level: 'C2' },
      ],
    });
    const out = await loadCandidateAggregates(['cand-1'], deps);
    expect(out[0]!.languages).toEqual([
      { name: 'English', level: 'B2' },
      { name: 'Spanish', level: 'C2' },
    ]);
  });

  it('deterministic: same inputs → same output', async () => {
    const rows: CandidateExperienceRow[] = [
      mkExpRow({ candidate_id: 'cand-1', id: 'e1' }),
      mkExpRow({
        candidate_id: 'cand-1',
        id: 'e2',
        start_date: '2018-01-01',
        end_date: '2019-01-01',
      }),
    ];
    const langs: CandidateLanguageRow[] = [
      { candidate_id: 'cand-1', name: 'English', level: 'B2' },
    ];
    const out1 = await loadCandidateAggregates(
      ['cand-1'],
      mkDeps({ experiences: rows, languages: langs }),
    );
    const out2 = await loadCandidateAggregates(
      ['cand-1'],
      mkDeps({ experiences: rows, languages: langs }),
    );
    expect(JSON.stringify(out1)).toBe(JSON.stringify(out2));
  });
});
