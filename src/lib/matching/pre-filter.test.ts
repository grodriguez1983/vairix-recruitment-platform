/**
 * Unit tests for `preFilterByMustHave` (F4-008 sub-B).
 *
 * Before running the (relatively expensive) aggregate loader +
 * deterministic ranker, we narrow the candidate set to those who
 * have at least one `experience_skills` row for *every* resolved
 * must-have skill.
 *
 * Invariants from ADR-015:
 *   - Unresolved must-have (`skill_id = null`) does NOT filter
 *     candidates: catalog drift must not silently hide people.
 *   - No resolved must-have → full candidate set passes through.
 *   - Resolved must-have → AND-intersection of candidates per skill.
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

function jobQuery(overrides: Partial<ResolvedDecomposition> = {}): ResolvedDecomposition {
  return {
    requirements: overrides.requirements ?? [],
    seniority: overrides.seniority ?? 'unspecified',
    languages: overrides.languages ?? [],
    notes: overrides.notes ?? null,
  };
}

function mkDeps(overrides: { withAll?: string[]; all?: string[] }): PreFilterByMustHaveDeps {
  return {
    fetchCandidatesWithAllSkills: vi.fn(async () => overrides.withAll ?? []),
    fetchAllCandidateIds: vi.fn(async () => overrides.all ?? []),
  };
}

describe('preFilterByMustHave — F4-008 sub-B', () => {
  it('no requirements → all candidates pass through', async () => {
    const deps = mkDeps({ all: ['a', 'b', 'c'] });
    const out = await preFilterByMustHave(jobQuery(), null, deps);
    expect(out).toEqual(['a', 'b', 'c']);
    expect(deps.fetchAllCandidateIds).toHaveBeenCalledWith(null);
    expect(deps.fetchCandidatesWithAllSkills).not.toHaveBeenCalled();
  });

  it('requirements but no must-have → all candidates pass through', async () => {
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
          },
        ],
      }),
      null,
      deps,
    );
    expect(out).toEqual(['a', 'b']);
    expect(deps.fetchCandidatesWithAllSkills).not.toHaveBeenCalled();
  });

  it('all must-have unresolved (skill_id=null) → all candidates pass through', async () => {
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
          },
        ],
      }),
      null,
      deps,
    );
    expect(out).toEqual(['a', 'b']);
    expect(deps.fetchCandidatesWithAllSkills).not.toHaveBeenCalled();
  });

  it('single resolved must-have → delegates to fetchCandidatesWithAllSkills', async () => {
    const deps = mkDeps({ withAll: ['match-1', 'match-2'] });
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
          },
        ],
      }),
      null,
      deps,
    );
    expect(out).toEqual(['match-1', 'match-2']);
    expect(deps.fetchCandidatesWithAllSkills).toHaveBeenCalledWith([REACT_ID], null);
  });

  it('multiple resolved must-have → uses AND-intersection (all skill_ids)', async () => {
    const deps = mkDeps({ withAll: ['only-full-stack'] });
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
          },
        ],
      }),
      null,
      deps,
    );
    expect(out).toEqual(['only-full-stack']);
    expect(deps.fetchCandidatesWithAllSkills).toHaveBeenCalledTimes(1);
    const call = (deps.fetchCandidatesWithAllSkills as ReturnType<typeof vi.fn>).mock.calls[0]!;
    const [skillIds, tenant] = call;
    expect((skillIds as string[]).sort()).toEqual([REACT_ID, NODE_ID].sort());
    expect(tenant).toBeNull();
  });

  it('mixed resolved + unresolved must-have → only resolved ones drive the filter', async () => {
    const deps = mkDeps({ withAll: ['x'] });
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
          },
        ],
      }),
      null,
      deps,
    );
    expect(out).toEqual(['x']);
    expect(deps.fetchCandidatesWithAllSkills).toHaveBeenCalledWith([REACT_ID], null);
  });

  it('propagates tenant_id to deps', async () => {
    const deps = mkDeps({ all: [] });
    await preFilterByMustHave(jobQuery(), 'tenant-42', deps);
    expect(deps.fetchAllCandidateIds).toHaveBeenCalledWith('tenant-42');
  });

  it('empty DB result → empty list (no throw)', async () => {
    const deps = mkDeps({ withAll: [] });
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
          },
        ],
      }),
      null,
      deps,
    );
    expect(out).toEqual([]);
  });
});
