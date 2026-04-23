/**
 * Unit tests for `decomposeJobQuery` (ADR-014 §5).
 *
 * Orchestrates the full pipeline with all I/O injected:
 *
 *   preprocess → hash → findByHash → (miss: provider.decompose +
 *     insert; hit: re-resolve and maybe update resolved_json).
 *
 * Contract pinned here:
 *   - Empty input (after preprocess) → DecompositionError('empty_input').
 *   - Provider schema failures surface as 'schema_violation'.
 *   - Provider HTTP failures surface as 'provider_failure'.
 *   - evidence_snippet NOT literal substring of normalized_text →
 *     'hallucinated_snippet'.
 *   - Cache miss: insertJobQuery called with (content_hash, raw_text,
 *     model, prompt_version, decomposed_json, resolved_json,
 *     unresolved_skills, created_by, tenant_id).
 *   - Cache hit with unchanged catalog: no updateResolved call, no
 *     insert, return cached.
 *   - Cache hit with catalog drift (unresolved_skills changed):
 *     updateResolved called with new resolved_json + unresolved_skills.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { decomposeJobQuery, type DecomposeJobQueryDeps } from './decompose-job-query';
import { DecompositionError } from './errors';
import { decompositionContentHash } from './hash';
import { preprocess } from './preprocess';
import type { DecompositionResult } from './types';
import type { CatalogSnapshot } from '../../skills/resolver';

const STUB_MODEL = 'stub-v1';
const STUB_PROMPT = 'stub-p1';
const CREATED_BY = '00000000-0000-0000-0000-000000000001';

function emptyCatalog(): CatalogSnapshot {
  return { slugMap: new Map(), aliasMap: new Map() };
}

function catalogWith(entries: Array<[string, string]>): CatalogSnapshot {
  return { slugMap: new Map(entries), aliasMap: new Map() };
}

function baseDeps(overrides: Partial<DecomposeJobQueryDeps> = {}): DecomposeJobQueryDeps {
  const defaults: DecomposeJobQueryDeps = {
    provider: {
      model: STUB_MODEL,
      promptVersion: STUB_PROMPT,
      decompose: vi.fn(async () => sampleResult('Node.js')),
    },
    loadCatalog: vi.fn(async () => emptyCatalog()),
    findByHash: vi.fn(async () => null),
    insertJobQuery: vi.fn(async () => ({ id: 'jq-1' })),
    updateResolved: vi.fn(async () => undefined),
    createdBy: CREATED_BY,
    tenantId: null,
  };
  return { ...defaults, ...overrides };
}

function sampleResult(skillRaw: string): DecompositionResult {
  return {
    requirements: [
      {
        skill_raw: skillRaw,
        min_years: 3,
        max_years: null,
        must_have: true,
        evidence_snippet: '3+ años',
        category: 'technical',
        alternative_group_id: null,
      },
    ],
    seniority: 'senior',
    languages: [],
    notes: null,
  };
}

describe('decomposeJobQuery — empty input', () => {
  it('throws DecompositionError(empty_input) when raw_text is blank', async () => {
    const deps = baseDeps();
    await expect(decomposeJobQuery('   ', deps)).rejects.toMatchObject({
      name: 'DecompositionError',
      code: 'empty_input',
    });
    expect(deps.provider.decompose).not.toHaveBeenCalled();
    expect(deps.findByHash).not.toHaveBeenCalled();
  });

  it('throws DecompositionError(empty_input) when raw_text is only HTML', async () => {
    const deps = baseDeps();
    await expect(decomposeJobQuery('<br/><p></p>', deps)).rejects.toBeInstanceOf(
      DecompositionError,
    );
    expect(deps.provider.decompose).not.toHaveBeenCalled();
  });
});

describe('decomposeJobQuery — cache miss', () => {
  const RAW = 'Buscamos backend sr con 3+ años de Node.js';
  let deps: DecomposeJobQueryDeps;

  beforeEach(() => {
    deps = baseDeps({
      loadCatalog: vi.fn(async () => catalogWith([['node.js', 'skill-node']])),
      provider: {
        model: STUB_MODEL,
        promptVersion: STUB_PROMPT,
        decompose: vi.fn(async () => sampleResult('Node.js')),
      },
    });
  });

  it('calls provider.decompose with the raw_text (not the preprocessed text)', async () => {
    await decomposeJobQuery(RAW, deps);
    expect(deps.provider.decompose).toHaveBeenCalledWith(RAW);
  });

  it('persists content_hash computed over preprocess(raw_text) + model + promptVersion', async () => {
    await decomposeJobQuery(RAW, deps);
    const expectedHash = decompositionContentHash(preprocess(RAW), STUB_MODEL, STUB_PROMPT);
    expect(deps.insertJobQuery).toHaveBeenCalledWith(
      expect.objectContaining({
        content_hash: expectedHash,
        model: STUB_MODEL,
        prompt_version: STUB_PROMPT,
        raw_text: RAW,
        created_by: CREATED_BY,
        tenant_id: null,
      }),
    );
  });

  it('persists decomposed_json (verbatim LLM output) and resolved_json (with skill_id)', async () => {
    await decomposeJobQuery(RAW, deps);
    const call = vi.mocked(deps.insertJobQuery).mock.calls[0]![0];
    expect(call.decomposed_json).toEqual(sampleResult('Node.js'));
    expect(call.resolved_json.requirements[0]!.skill_id).toBe('skill-node');
    expect(call.resolved_json.requirements[0]!.resolved_at).toBeTypeOf('string');
  });

  it('persists unresolved_skills when catalog does not hit', async () => {
    const d = baseDeps({
      loadCatalog: vi.fn(async () => emptyCatalog()),
      provider: {
        model: STUB_MODEL,
        promptVersion: STUB_PROMPT,
        decompose: vi.fn(async () => sampleResult('Kubernetes')),
      },
    });
    await decomposeJobQuery(RAW, d);
    const call = vi.mocked(d.insertJobQuery).mock.calls[0]![0];
    expect(call.unresolved_skills).toEqual(['Kubernetes']);
  });

  it('returns { query_id, cached: false, resolved, unresolved_skills }', async () => {
    const out = await decomposeJobQuery(RAW, deps);
    expect(out.query_id).toBe('jq-1');
    expect(out.cached).toBe(false);
    expect(out.resolved.requirements).toHaveLength(1);
    expect(out.unresolved_skills).toEqual([]);
  });

  it('does NOT call updateResolved on cache miss', async () => {
    await decomposeJobQuery(RAW, deps);
    expect(deps.updateResolved).not.toHaveBeenCalled();
  });
});

describe('decomposeJobQuery — cache hit', () => {
  const RAW = 'Buscamos backend sr con 3+ años de Node.js';

  function cachedRow(unresolvedAtCache: string[]) {
    return {
      id: 'jq-cached',
      content_hash: decompositionContentHash(preprocess(RAW), STUB_MODEL, STUB_PROMPT),
      decomposed_json: sampleResult('Node.js'),
      unresolved_skills: unresolvedAtCache,
    };
  }

  it('skips provider.decompose and insertJobQuery when hash is cached', async () => {
    const deps = baseDeps({
      findByHash: vi.fn(async () => cachedRow([])),
      loadCatalog: vi.fn(async () => catalogWith([['node.js', 'skill-node']])),
    });
    const out = await decomposeJobQuery(RAW, deps);
    expect(deps.provider.decompose).not.toHaveBeenCalled();
    expect(deps.insertJobQuery).not.toHaveBeenCalled();
    expect(out.cached).toBe(true);
    expect(out.query_id).toBe('jq-cached');
  });

  it('does NOT call updateResolved when catalog produces the same unresolved_skills set', async () => {
    // Cached as unresolved; catalog still does not resolve → stable.
    const deps = baseDeps({
      findByHash: vi.fn(async () => cachedRow(['Node.js'])),
      loadCatalog: vi.fn(async () => emptyCatalog()),
    });
    await decomposeJobQuery(RAW, deps);
    expect(deps.updateResolved).not.toHaveBeenCalled();
  });

  it('calls updateResolved when catalog drift changes unresolved_skills', async () => {
    // Cached as unresolved ['Node.js']; catalog now resolves it →
    // new unresolved_skills = [] → update.
    const deps = baseDeps({
      findByHash: vi.fn(async () => cachedRow(['Node.js'])),
      loadCatalog: vi.fn(async () => catalogWith([['node.js', 'skill-node']])),
    });
    await decomposeJobQuery(RAW, deps);
    expect(deps.updateResolved).toHaveBeenCalledWith(
      'jq-cached',
      expect.objectContaining({ requirements: expect.any(Array) }),
      [],
    );
  });

  it('order-independent diff: same set in different order is not a drift', async () => {
    const two = {
      requirements: [
        {
          skill_raw: 'A',
          min_years: null,
          max_years: null,
          must_have: true,
          evidence_snippet: 'A',
          category: 'technical' as const,
          alternative_group_id: null,
        },
        {
          skill_raw: 'B',
          min_years: null,
          max_years: null,
          must_have: true,
          evidence_snippet: 'B',
          category: 'technical' as const,
          alternative_group_id: null,
        },
      ],
      seniority: 'unspecified' as const,
      languages: [],
      notes: null,
    };
    const deps = baseDeps({
      findByHash: vi.fn(async () => ({
        id: 'jq-cached',
        content_hash: decompositionContentHash(preprocess('A B'), STUB_MODEL, STUB_PROMPT),
        decomposed_json: two,
        unresolved_skills: ['B', 'A'], // stored out-of-order vs current run
      })),
      loadCatalog: vi.fn(async () => emptyCatalog()),
    });
    await decomposeJobQuery('A B', deps);
    expect(deps.updateResolved).not.toHaveBeenCalled();
  });
});

describe('decomposeJobQuery — error mapping', () => {
  const RAW = 'Buscamos backend sr con Node.js';

  it('wraps provider HTTP/network errors as DecompositionError(provider_failure)', async () => {
    const deps = baseDeps({
      provider: {
        model: STUB_MODEL,
        promptVersion: STUB_PROMPT,
        decompose: vi.fn(async () => {
          throw new Error('429 rate_limited');
        }),
      },
    });
    await expect(decomposeJobQuery(RAW, deps)).rejects.toMatchObject({
      name: 'DecompositionError',
      code: 'provider_failure',
    });
    expect(deps.insertJobQuery).not.toHaveBeenCalled();
  });

  it('wraps Zod parse errors from the provider as schema_violation', async () => {
    class FakeZodError extends Error {
      override readonly name = 'ZodError';
    }
    const deps = baseDeps({
      provider: {
        model: STUB_MODEL,
        promptVersion: STUB_PROMPT,
        decompose: vi.fn(async () => {
          throw new FakeZodError('bad shape');
        }),
      },
    });
    await expect(decomposeJobQuery(RAW, deps)).rejects.toMatchObject({
      name: 'DecompositionError',
      code: 'schema_violation',
    });
  });

  it('rejects hallucinated evidence_snippet (not a substring of normalized_text)', async () => {
    const deps = baseDeps({
      provider: {
        model: STUB_MODEL,
        promptVersion: STUB_PROMPT,
        decompose: vi.fn(
          async (): Promise<DecompositionResult> => ({
            requirements: [
              {
                skill_raw: 'Node.js',
                min_years: 3,
                max_years: null,
                must_have: true,
                evidence_snippet: 'this text is NOT in the raw',
                category: 'technical',
                alternative_group_id: null,
              },
            ],
            seniority: 'senior',
            languages: [],
            notes: null,
          }),
        ),
      },
    });
    await expect(decomposeJobQuery(RAW, deps)).rejects.toMatchObject({
      name: 'DecompositionError',
      code: 'hallucinated_snippet',
    });
    expect(deps.insertJobQuery).not.toHaveBeenCalled();
  });
});
