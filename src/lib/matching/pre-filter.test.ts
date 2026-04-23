/**
 * Unit tests for `preFilterByMustHave` (F4-008 sub-B + F4-008 ter).
 *
 * Before running the (relatively expensive) aggregate loader +
 * deterministic ranker, we narrow the candidate set to those who
 * have at least one `experience_skills` row for *every* resolved
 * must-have skill.
 *
 * F4-008 ter (ADR-016 §"Gap conocido"): on top of the `included`
 * pool we now return an `excluded` pool of candidates with partial
 * or zero must-have coverage, annotated with the missing skill ids.
 * The rescue bucket picks that up so a candidate who only mentions
 * a must-have in `files.parsed_text` still gets a FTS lookup.
 *
 * Invariants from ADR-015:
 *   - Unresolved must-have (`skill_id = null`) does NOT filter
 *     candidates: catalog drift must not silently hide people.
 *   - No resolved must-have → full candidate set passes through as
 *     `included`; `excluded` is empty (nothing to rescue).
 *   - Resolved must-have → AND-intersection of candidates per skill
 *     for `included`; the complement is `excluded` with per-candidate
 *     `missing_must_have_skill_ids`.
 *
 * All I/O is injected so the unit suite doesn't need Supabase.
 */
import { describe, expect, it, vi } from 'vitest';

import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import { preFilterByMustHave } from './pre-filter';
import type { PreFilterByMustHaveDeps } from './pre-filter';

const REACT_ID = '00000000-0000-0000-0000-000000000001';
const NODE_ID = '00000000-0000-0000-0000-000000000002';
const SQL_ID = '00000000-0000-0000-0000-000000000003';
const TAILWIND_ID = '00000000-0000-0000-0000-000000000004';
const STYLED_ID = '00000000-0000-0000-0000-000000000005';

function jobQuery(overrides: Partial<ResolvedDecomposition> = {}): ResolvedDecomposition {
  return {
    requirements: overrides.requirements ?? [],
    seniority: overrides.seniority ?? 'unspecified',
    languages: overrides.languages ?? [],
    notes: overrides.notes ?? null,
  };
}

interface MkDepsOverrides {
  all?: string[];
  coverage?: Array<{ candidate_id: string; covered_skill_ids: string[] }>;
}

function mkDeps(overrides: MkDepsOverrides = {}): PreFilterByMustHaveDeps {
  return {
    fetchAllCandidateIds: vi.fn(async () => overrides.all ?? []),
    fetchCandidateMustHaveCoverage: vi.fn(async () => overrides.coverage ?? []),
  };
}

describe('preFilterByMustHave — F4-008 sub-B + ter', () => {
  it('no requirements → all candidates pass through, empty excluded', async () => {
    const deps = mkDeps({ all: ['a', 'b', 'c'] });
    const out = await preFilterByMustHave(jobQuery(), null, deps);
    expect(out.included).toEqual(['a', 'b', 'c']);
    expect(out.excluded).toEqual([]);
    expect(deps.fetchAllCandidateIds).toHaveBeenCalledWith(null);
    expect(deps.fetchCandidateMustHaveCoverage).not.toHaveBeenCalled();
  });

  it('requirements but no must-have → all pass through, empty excluded', async () => {
    const deps = mkDeps({ all: ['a', 'b'] });
    const out = await preFilterByMustHave(
      jobQuery({
        requirements: [
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
      }),
      null,
      deps,
    );
    expect(out.included).toEqual(['a', 'b']);
    expect(out.excluded).toEqual([]);
    expect(deps.fetchCandidateMustHaveCoverage).not.toHaveBeenCalled();
  });

  it('all must-have unresolved (skill_id=null) → all pass through, empty excluded', async () => {
    const deps = mkDeps({ all: ['a', 'b'] });
    const out = await preFilterByMustHave(
      jobQuery({
        requirements: [
          {
            skill_raw: 'Obscure Framework',
            skill_id: null,
            resolved_at: null,
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Obscure',
            category: 'technical',
            alternative_group_id: null,
          },
        ],
      }),
      null,
      deps,
    );
    expect(out.included).toEqual(['a', 'b']);
    expect(out.excluded).toEqual([]);
    expect(deps.fetchCandidateMustHaveCoverage).not.toHaveBeenCalled();
  });

  it('single resolved must-have → included = full coverage, excluded = partial + zero', async () => {
    // Pool: a, b, c, d.  React must-have.
    //  - a, b have React in experience_skills → included.
    //  - c has nothing → excluded with missing=[React].
    //  - d has React too → included. (coverage includes d.)
    const deps = mkDeps({
      all: ['a', 'b', 'c', 'd'],
      coverage: [
        { candidate_id: 'a', covered_skill_ids: [REACT_ID] },
        { candidate_id: 'b', covered_skill_ids: [REACT_ID] },
        { candidate_id: 'd', covered_skill_ids: [REACT_ID] },
      ],
    });
    const out = await preFilterByMustHave(
      jobQuery({
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
      null,
      deps,
    );
    expect(out.included.sort()).toEqual(['a', 'b', 'd']);
    expect(out.excluded).toEqual([{ candidate_id: 'c', missing_must_have_skill_ids: [REACT_ID] }]);
    expect(deps.fetchCandidateMustHaveCoverage).toHaveBeenCalledWith([REACT_ID], null);
  });

  it('multiple resolved must-have → partial coverage surfaces with specific missing ids', async () => {
    // React + Node must-have.
    //  - a has both → included.
    //  - b has only React → excluded with missing=[Node].
    //  - c has only Node → excluded with missing=[React].
    //  - d has nothing → excluded with missing=[React, Node].
    //  - e has Node + irrelevant (ignored) → same as c.
    //  - non-must-have SQL is ignored throughout.
    const deps = mkDeps({
      all: ['a', 'b', 'c', 'd', 'e'],
      coverage: [
        { candidate_id: 'a', covered_skill_ids: [REACT_ID, NODE_ID] },
        { candidate_id: 'b', covered_skill_ids: [REACT_ID] },
        { candidate_id: 'c', covered_skill_ids: [NODE_ID] },
        { candidate_id: 'e', covered_skill_ids: [NODE_ID] },
      ],
    });
    const out = await preFilterByMustHave(
      jobQuery({
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
          {
            skill_raw: 'Node.js',
            skill_id: NODE_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Node.js',
            category: 'technical',
            alternative_group_id: null,
          },
          // non must-have → ignored by pre-filter
          {
            skill_raw: 'SQL',
            skill_id: SQL_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: false,
            evidence_snippet: 'SQL',
            category: 'technical',
            alternative_group_id: null,
          },
        ],
      }),
      null,
      deps,
    );

    expect(out.included).toEqual(['a']);

    // Excluded sorted by candidate_id for determinism.
    const byCandidate = new Map(
      out.excluded.map((e) => [e.candidate_id, e.missing_must_have_skill_ids]),
    );
    expect(byCandidate.get('b')?.sort()).toEqual([NODE_ID]);
    expect(byCandidate.get('c')?.sort()).toEqual([REACT_ID]);
    expect(byCandidate.get('d')?.sort()).toEqual([REACT_ID, NODE_ID].sort());
    expect(byCandidate.get('e')?.sort()).toEqual([REACT_ID]);
    expect(out.excluded.length).toBe(4);

    const call = (deps.fetchCandidateMustHaveCoverage as ReturnType<typeof vi.fn>).mock.calls[0]!;
    expect((call[0] as string[]).sort()).toEqual([REACT_ID, NODE_ID].sort());
    expect(call[1]).toBeNull();
  });

  it('mixed resolved + unresolved must-have → only resolved ones drive the filter', async () => {
    // React resolved, Obscure unresolved.
    //  - x has React → included.
    //  - y has nothing → excluded with missing=[React] only (unresolved skipped).
    const deps = mkDeps({
      all: ['x', 'y'],
      coverage: [{ candidate_id: 'x', covered_skill_ids: [REACT_ID] }],
    });
    const out = await preFilterByMustHave(
      jobQuery({
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
          {
            skill_raw: 'Obscure Framework',
            skill_id: null,
            resolved_at: null,
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Obscure',
            category: 'technical',
            alternative_group_id: null,
          },
        ],
      }),
      null,
      deps,
    );
    expect(out.included).toEqual(['x']);
    expect(out.excluded).toEqual([{ candidate_id: 'y', missing_must_have_skill_ids: [REACT_ID] }]);
    expect(deps.fetchCandidateMustHaveCoverage).toHaveBeenCalledWith([REACT_ID], null);
  });

  it('propagates tenant_id to deps', async () => {
    const deps = mkDeps({ all: [] });
    await preFilterByMustHave(jobQuery(), 'tenant-42', deps);
    expect(deps.fetchAllCandidateIds).toHaveBeenCalledWith('tenant-42');
  });

  it('empty DB result → empty included + empty excluded (no throw)', async () => {
    const deps = mkDeps({ all: [], coverage: [] });
    const out = await preFilterByMustHave(
      jobQuery({
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
      null,
      deps,
    );
    expect(out.included).toEqual([]);
    expect(out.excluded).toEqual([]);
  });

  // ----------------------------------------------------------
  // ADR-021: alternative_group_id. Within a group the semantics
  // flip from AND to OR — a candidate covers the group if they
  // have at least one resolved alternative. Between groups it
  // stays AND.
  // ----------------------------------------------------------

  it('OR group: candidate with any ONE alternative passes the group', async () => {
    // g-css = {Tailwind, styled-components}, both must_have.
    // a has Tailwind only → passes (covers g-css via Tailwind).
    // b has styled-components only → passes.
    // c has both → passes.
    // d has neither → excluded; missing surfaces ALL alternatives so the
    //   rescue layer can FTS each one in files.parsed_text.
    const deps = mkDeps({
      all: ['a', 'b', 'c', 'd'],
      coverage: [
        { candidate_id: 'a', covered_skill_ids: [TAILWIND_ID] },
        { candidate_id: 'b', covered_skill_ids: [STYLED_ID] },
        { candidate_id: 'c', covered_skill_ids: [TAILWIND_ID, STYLED_ID] },
      ],
    });
    const out = await preFilterByMustHave(
      jobQuery({
        requirements: [
          {
            skill_raw: 'Tailwind',
            skill_id: TAILWIND_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'CSS moderno (Tailwind o styled-components)',
            category: 'technical',
            alternative_group_id: 'g-css',
          },
          {
            skill_raw: 'styled-components',
            skill_id: STYLED_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'CSS moderno (Tailwind o styled-components)',
            category: 'technical',
            alternative_group_id: 'g-css',
          },
        ],
      }),
      null,
      deps,
    );
    expect(out.included.sort()).toEqual(['a', 'b', 'c']);
    expect(out.excluded).toHaveLength(1);
    expect(out.excluded[0]?.candidate_id).toBe('d');
    expect(out.excluded[0]?.missing_must_have_skill_ids.sort()).toEqual(
      [TAILWIND_ID, STYLED_ID].sort(),
    );
  });

  it('singleton + OR group: candidate needs singleton AND one from the group', async () => {
    // React (singleton, must_have) + g-css {Tailwind, styled-components}.
    //  - a: React + Tailwind → included.
    //  - b: React + styled-components → included.
    //  - c: React only → excluded; missing = both alternatives.
    //  - d: Tailwind only → excluded; missing = React.
    //  - e: nothing → excluded; missing = React + both alternatives.
    const deps = mkDeps({
      all: ['a', 'b', 'c', 'd', 'e'],
      coverage: [
        { candidate_id: 'a', covered_skill_ids: [REACT_ID, TAILWIND_ID] },
        { candidate_id: 'b', covered_skill_ids: [REACT_ID, STYLED_ID] },
        { candidate_id: 'c', covered_skill_ids: [REACT_ID] },
        { candidate_id: 'd', covered_skill_ids: [TAILWIND_ID] },
      ],
    });
    const out = await preFilterByMustHave(
      jobQuery({
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
          {
            skill_raw: 'Tailwind',
            skill_id: TAILWIND_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Tailwind o styled-components',
            category: 'technical',
            alternative_group_id: 'g-css',
          },
          {
            skill_raw: 'styled-components',
            skill_id: STYLED_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Tailwind o styled-components',
            category: 'technical',
            alternative_group_id: 'g-css',
          },
        ],
      }),
      null,
      deps,
    );
    expect(out.included.sort()).toEqual(['a', 'b']);
    const byCandidate = new Map(
      out.excluded.map((e) => [e.candidate_id, [...e.missing_must_have_skill_ids].sort()]),
    );
    expect(byCandidate.get('c')).toEqual([TAILWIND_ID, STYLED_ID].sort());
    expect(byCandidate.get('d')).toEqual([REACT_ID]);
    expect(byCandidate.get('e')).toEqual([REACT_ID, TAILWIND_ID, STYLED_ID].sort());
  });

  it('OR group with one unresolved alternative: only resolved drives coverage', async () => {
    // g-css = {Tailwind (resolved), styled-components (unresolved)}.
    // The unresolved alternative contributes nothing to the filter —
    // the group is satisfied iff the candidate has Tailwind.
    const deps = mkDeps({
      all: ['a', 'b'],
      coverage: [{ candidate_id: 'a', covered_skill_ids: [TAILWIND_ID] }],
    });
    const out = await preFilterByMustHave(
      jobQuery({
        requirements: [
          {
            skill_raw: 'Tailwind',
            skill_id: TAILWIND_ID,
            resolved_at: '2025-01-01T00:00:00Z',
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Tailwind o styled-components',
            category: 'technical',
            alternative_group_id: 'g-css',
          },
          {
            skill_raw: 'styled-components',
            skill_id: null,
            resolved_at: null,
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Tailwind o styled-components',
            category: 'technical',
            alternative_group_id: 'g-css',
          },
        ],
      }),
      null,
      deps,
    );
    expect(out.included).toEqual(['a']);
    expect(out.excluded).toEqual([
      { candidate_id: 'b', missing_must_have_skill_ids: [TAILWIND_ID] },
    ]);
    // The coverage query only asks for the resolved alternative.
    expect(deps.fetchCandidateMustHaveCoverage).toHaveBeenCalledWith([TAILWIND_ID], null);
  });

  it('OR group fully unresolved → does not filter (consistent with ADR-015)', async () => {
    // All alternatives unresolved → the group drops out of the
    // filter entirely. Full candidate pool passes through; the
    // group is the rescue layer's problem.
    const deps = mkDeps({ all: ['a', 'b'] });
    const out = await preFilterByMustHave(
      jobQuery({
        requirements: [
          {
            skill_raw: 'Remix',
            skill_id: null,
            resolved_at: null,
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Next.js o Remix',
            category: 'technical',
            alternative_group_id: 'g-ssr',
          },
          {
            skill_raw: 'Next.js',
            skill_id: null,
            resolved_at: null,
            min_years: 1,
            max_years: null,
            must_have: true,
            evidence_snippet: 'Next.js o Remix',
            category: 'technical',
            alternative_group_id: 'g-ssr',
          },
        ],
      }),
      null,
      deps,
    );
    expect(out.included).toEqual(['a', 'b']);
    expect(out.excluded).toEqual([]);
    expect(deps.fetchCandidateMustHaveCoverage).not.toHaveBeenCalled();
  });

  it('coverage row with zero covered_skill_ids → still treated as excluded with all missing', async () => {
    // Defensive: the DB could emit an empty covered_skill_ids array
    // if we filtered server-side. Must behave identically to absent.
    const deps = mkDeps({
      all: ['a', 'b'],
      coverage: [
        { candidate_id: 'a', covered_skill_ids: [REACT_ID] },
        { candidate_id: 'b', covered_skill_ids: [] },
      ],
    });
    const out = await preFilterByMustHave(
      jobQuery({
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
      null,
      deps,
    );
    expect(out.included).toEqual(['a']);
    expect(out.excluded).toEqual([{ candidate_id: 'b', missing_must_have_skill_ids: [REACT_ID] }]);
  });
});
