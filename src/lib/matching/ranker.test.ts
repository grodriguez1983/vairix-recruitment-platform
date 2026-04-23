/**
 * Unit tests for `DeterministicRanker` (ADR-015, F4-007 sub-D).
 *
 * The ranker is the orchestrator: it applies `aggregateScore` to every
 * candidate, sorts the results by (score desc, candidate_id asc), and
 * emits diagnostics. `catalogSnapshotAt` is used as the `now` passed to
 * the aggregator so the whole pipeline is reproducible — same inputs +
 * same snapshot → bit-identical output (ADR test 21).
 */
import { describe, expect, it } from 'vitest';

import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import { DeterministicRanker } from './ranker';
import type { CandidateAggregate, ExperienceSkill, MergedExperience } from './types';

const REACT_ID = '00000000-0000-0000-0000-000000000001';
const NODE_ID = '00000000-0000-0000-0000-000000000002';
const SNAPSHOT = new Date('2025-01-01T00:00:00Z');

function mkExp(params: {
  id: string;
  start: string;
  end: string;
  skills: ExperienceSkill[];
}): MergedExperience {
  return {
    id: params.id,
    source_variant: 'cv_primary',
    kind: 'work',
    company: 'Acme',
    title: 'Engineer',
    start_date: params.start,
    end_date: params.end,
    description: null,
    skills: params.skills,
    merged_from_ids: [params.id],
  };
}

function mkCandidate(
  id: string,
  merged_experiences: MergedExperience[] = [],
  languages: CandidateAggregate['languages'] = [],
): CandidateAggregate {
  return { candidate_id: id, merged_experiences, languages };
}

function jobQuery(overrides: Partial<ResolvedDecomposition> = {}): ResolvedDecomposition {
  return {
    requirements: overrides.requirements ?? [
      {
        skill_raw: 'React',
        skill_id: REACT_ID,
        resolved_at: '2025-01-01T00:00:00Z',
        min_years: 1,
        max_years: null,
        must_have: false,
        evidence_snippet: 'React',
        category: 'technical',
        alternative_group_id: null,
      },
    ],
    seniority: overrides.seniority ?? 'unspecified',
    languages: overrides.languages ?? [],
    notes: overrides.notes ?? null,
  };
}

describe('DeterministicRanker — ADR-015', () => {
  it('empty candidate list → empty results, no diagnostics', async () => {
    const ranker = new DeterministicRanker();
    const out = await ranker.rank({
      jobQuery: jobQuery(),
      candidates: [],
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(out.results).toEqual([]);
    expect(out.diagnostics).toEqual([]);
  });

  it('single candidate → single scored result', async () => {
    const ranker = new DeterministicRanker();
    const c = mkCandidate('cand-1', [
      mkExp({
        id: 'e1',
        start: '2020-01-01',
        end: '2024-01-01',
        skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
      }),
    ]);
    const out = await ranker.rank({
      jobQuery: jobQuery(),
      candidates: [c],
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(out.results).toHaveLength(1);
    expect(out.results[0]!.candidate_id).toBe('cand-1');
    expect(out.results[0]!.total_score).toBe(100);
  });

  it('sorts by total_score descending', async () => {
    const ranker = new DeterministicRanker();
    const senior = mkCandidate('aa-senior', [
      mkExp({
        id: 'e1',
        start: '2020-01-01',
        end: '2024-01-01',
        skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
      }),
    ]);
    const junior = mkCandidate('bb-junior', [
      mkExp({
        id: 'e2',
        start: '2024-06-01',
        end: '2024-12-01',
        skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
      }),
    ]);
    const out = await ranker.rank({
      jobQuery: jobQuery({
        requirements: [
          {
            skill_raw: 'React',
            skill_id: REACT_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 4,
            max_years: null,
            must_have: false,
            evidence_snippet: 'React',
            category: 'technical',
            alternative_group_id: null,
          },
        ],
      }),
      candidates: [junior, senior],
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(out.results.map((r) => r.candidate_id)).toEqual(['aa-senior', 'bb-junior']);
    expect(out.results[0]!.total_score).toBeGreaterThan(out.results[1]!.total_score);
  });

  it('ties broken by candidate_id ascending', async () => {
    const ranker = new DeterministicRanker();
    const exp = (id: string): MergedExperience =>
      mkExp({
        id,
        start: '2020-01-01',
        end: '2023-01-01',
        skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
      });
    const beta = mkCandidate('beta', [exp('b1')]);
    const alpha = mkCandidate('alpha', [exp('a1')]);
    const gamma = mkCandidate('gamma', [exp('g1')]);
    const out = await ranker.rank({
      jobQuery: jobQuery(),
      candidates: [beta, gamma, alpha],
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(out.results.map((r) => r.candidate_id)).toEqual(['alpha', 'beta', 'gamma']);
  });

  it('gate-failed candidates are still returned (with score 0, flagged)', async () => {
    const ranker = new DeterministicRanker();
    const hasReact = mkCandidate('good', [
      mkExp({
        id: 'e',
        start: '2020-01-01',
        end: '2024-01-01',
        skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
      }),
    ]);
    const missingReact = mkCandidate('bad', [
      mkExp({
        id: 'e',
        start: '2020-01-01',
        end: '2024-01-01',
        skills: [{ skill_id: NODE_ID, skill_raw: 'Node.js' }],
      }),
    ]);
    const out = await ranker.rank({
      jobQuery: jobQuery({
        requirements: [
          {
            skill_raw: 'React',
            skill_id: REACT_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'React',
            category: 'technical',
            alternative_group_id: null,
          },
        ],
      }),
      candidates: [hasReact, missingReact],
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(out.results).toHaveLength(2);
    const ids = out.results.map((r) => r.candidate_id);
    expect(ids[0]).toBe('good');
    expect(ids[1]).toBe('bad');
    expect(out.results[1]!.must_have_gate).toBe('failed');
    expect(out.results[1]!.total_score).toBe(0);
  });

  it('test_match_run_idempotent_same_inputs — same inputs → bit-identical output', async () => {
    const ranker = new DeterministicRanker();
    const exp = mkExp({
      id: 'e1',
      start: '2020-01-01',
      end: '2023-01-01',
      skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
    });
    const input = {
      jobQuery: jobQuery(),
      candidates: [mkCandidate('c1', [exp]), mkCandidate('c2', [exp])],
      catalogSnapshotAt: SNAPSHOT,
    };
    const a = await ranker.rank(input);
    const b = await ranker.rank(input);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('uses catalogSnapshotAt as the temporal anchor for years calculations', async () => {
    const ranker = new DeterministicRanker();
    // end_date=null is interpreted as `now` = catalogSnapshotAt.
    // Candidate: React 2020-01-01 → null (open-ended).
    // Snapshot A: 2024-01-01 → 4 years → ratio 1.0 → score 100.
    // Snapshot B: 2021-01-01 → 1 year  → ratio 0.25 → score 25.
    const c = mkCandidate('c1', [
      mkExp({
        id: 'e',
        start: '2020-01-01',
        end: '9999-12-31', // use finite end first; then null test below
        skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
      }),
    ]);
    // Replace end with null to exercise the snapshot anchor.
    c.merged_experiences[0]!.end_date = null;
    const jq = jobQuery({
      requirements: [
        {
          skill_raw: 'React',
          skill_id: REACT_ID,
          resolved_at: '2024-01-01T00:00:00Z',
          min_years: 4,
          max_years: null,
          must_have: false,
          evidence_snippet: 'React',
          category: 'technical',
          alternative_group_id: null,
        },
      ],
    });
    const atLater = await ranker.rank({
      jobQuery: jq,
      candidates: [c],
      catalogSnapshotAt: new Date('2024-01-01T00:00:00Z'),
    });
    const atEarlier = await ranker.rank({
      jobQuery: jq,
      candidates: [c],
      catalogSnapshotAt: new Date('2021-01-01T00:00:00Z'),
    });
    expect(atLater.results[0]!.total_score).toBeGreaterThan(atEarlier.results[0]!.total_score);
  });

  it('input array order does not affect output (permutation invariance)', async () => {
    const ranker = new DeterministicRanker();
    const mk = (id: string): CandidateAggregate =>
      mkCandidate(id, [
        mkExp({
          id: `${id}-e`,
          start: '2020-01-01',
          end: '2023-01-01',
          skills: [{ skill_id: REACT_ID, skill_raw: 'React' }],
        }),
      ]);
    const a = await ranker.rank({
      jobQuery: jobQuery(),
      candidates: [mk('alpha'), mk('beta'), mk('gamma')],
      catalogSnapshotAt: SNAPSHOT,
    });
    const b = await ranker.rank({
      jobQuery: jobQuery(),
      candidates: [mk('gamma'), mk('alpha'), mk('beta')],
      catalogSnapshotAt: SNAPSHOT,
    });
    expect(a.results.map((r) => r.candidate_id)).toEqual(b.results.map((r) => r.candidate_id));
  });
});
