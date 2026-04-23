/**
 * Integration test for `decomposeJobQuery` (ADR-014 §5).
 *
 * Wires the service against a local Supabase instance with a
 * deterministic stub provider (no OpenAI key required). The focus
 * is the SQL side of the contract:
 *
 *   - Cache miss inserts a row in `job_queries` that satisfies the
 *     NOT-NULLs, the UNIQUE(content_hash), and the immutability
 *     trigger (no update to the frozen columns).
 *   - Cache hit on the same raw_text (and a trivially-different
 *     whitespace variant) returns the same query_id without a new
 *     INSERT. The preprocess invariant ties these two submissions
 *     to the same hash.
 *   - Catalog drift: when the catalog is updated between two runs,
 *     the cached row's resolved_json + unresolved_skills are
 *     updated in place — decomposed_json stays frozen (trigger).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

import {
  decomposeJobQuery,
  type DecomposeJobQueryDeps,
  type JobQueryInsertRow,
} from '../../../src/lib/rag/decomposition/decompose-job-query';
import { createStubDecompositionProvider } from '../../../src/lib/rag/decomposition/stub-provider';
import type { DecompositionResult } from '../../../src/lib/rag/decomposition/types';
import type { ResolvedDecomposition } from '../../../src/lib/rag/decomposition/resolve-requirements';
import { loadCatalogSnapshot } from '../../../src/lib/skills/catalog-loader';

const SUPABASE_URL = process.env.SUPABASE_TEST_URL ?? 'http://127.0.0.1:54321';
const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_TEST_SERVICE_ROLE_KEY ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZS1kZW1vIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImV4cCI6MTk4MzgxMjk5Nn0.EGIM96RAZx35lJzdJsyH-qQwv8Hdp7fsn3W0YpN81IU';

const TEST_EMAIL = 'decompose-e2e@example.test';
const TEST_SKILL_SLUG = 'decompose-e2e-nodejs';

function svc(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function ensureAuthUser(db: SupabaseClient, email: string): Promise<string> {
  const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
  const existing = list?.users?.find((u) => u.email === email);
  if (existing) await db.auth.admin.deleteUser(existing.id);
  const { data, error } = await db.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw new Error(`auth create failed: ${error?.message}`);
  return data.user.id;
}

function fixtureResult(): DecompositionResult {
  // Evidence snippet must be a literal substring of the raw_text,
  // which we supply below.
  return {
    requirements: [
      {
        skill_raw: 'Decompose-E2E-NodeJS',
        min_years: 3,
        max_years: null,
        must_have: true,
        evidence_snippet: '3+ años',
        category: 'technical',
        alternative_group_id: null,
      },
      {
        skill_raw: 'Decompose-E2E-Uncataloged',
        min_years: null,
        max_years: null,
        must_have: false,
        evidence_snippet: 'deseable',
        category: 'technical',
        alternative_group_id: null,
      },
    ],
    seniority: 'senior',
    languages: [],
    notes: null,
  };
}

function buildDeps(
  db: SupabaseClient,
  provider: ReturnType<typeof createStubDecompositionProvider>,
  createdBy: string,
): DecomposeJobQueryDeps {
  return {
    provider,
    loadCatalog: () => loadCatalogSnapshot(db),
    findByHash: async (hash) => {
      const { data, error } = await db
        .from('job_queries')
        .select('id, content_hash, decomposed_json, unresolved_skills')
        .eq('content_hash', hash)
        .maybeSingle();
      if (error) throw new Error(error.message);
      if (data === null) return null;
      return {
        id: data.id as string,
        content_hash: data.content_hash as string,
        decomposed_json: data.decomposed_json as DecompositionResult,
        unresolved_skills: (data.unresolved_skills as string[]) ?? [],
      };
    },
    insertJobQuery: async (row: JobQueryInsertRow) => {
      const { data, error } = await db
        .from('job_queries')
        .insert({
          content_hash: row.content_hash,
          raw_text: row.raw_text,
          normalized_text: row.normalized_text,
          model: row.model,
          prompt_version: row.prompt_version,
          decomposed_json: row.decomposed_json,
          resolved_json: row.resolved_json,
          unresolved_skills: row.unresolved_skills,
          created_by: row.created_by,
          tenant_id: row.tenant_id,
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(error?.message ?? 'insert failed');
      return { id: data.id as string };
    },
    updateResolved: async (id, resolved: ResolvedDecomposition, unresolved) => {
      const { error } = await db
        .from('job_queries')
        .update({
          resolved_json: resolved,
          unresolved_skills: unresolved,
          resolved_at: new Date().toISOString(),
        })
        .eq('id', id);
      if (error) throw new Error(error.message);
    },
    createdBy,
    tenantId: null,
  };
}

describe('decomposeJobQuery (integration)', () => {
  const db = svc();
  let appUserId: string;
  let authUserId: string;
  let seededSkillId: string | null = null;

  const RAW = 'Buscamos backend sr con 3+ años de Decompose-E2E-NodeJS; deseable AWS.';

  beforeEach(async () => {
    await db
      .from('job_queries')
      .delete()
      .eq('created_by', appUserId ?? '00000000-0000-0000-0000-000000000000');
    await db.from('app_users').delete().eq('email', TEST_EMAIL);
    authUserId = await ensureAuthUser(db, TEST_EMAIL);
    const { data: appUser, error } = await db
      .from('app_users')
      .insert({ auth_user_id: authUserId, email: TEST_EMAIL, role: 'recruiter' })
      .select('id')
      .single();
    if (error) throw error;
    appUserId = appUser!.id as string;

    // Clean any leftover skill from prior runs.
    await db.from('skills').delete().eq('slug', TEST_SKILL_SLUG);
    seededSkillId = null;
  });

  afterEach(async () => {
    await db.from('job_queries').delete().eq('created_by', appUserId);
    await db.from('app_users').delete().eq('email', TEST_EMAIL);
    if (seededSkillId !== null) {
      await db.from('skills').delete().eq('id', seededSkillId);
      seededSkillId = null;
    }
    const { data: list } = await db.auth.admin.listUsers({ page: 1, perPage: 200 });
    for (const u of list?.users ?? []) {
      if (u.email === TEST_EMAIL) await db.auth.admin.deleteUser(u.id);
    }
  });

  it('cache miss: inserts a job_queries row with all NOT-NULL columns', async () => {
    const provider = createStubDecompositionProvider({ fixture: fixtureResult() });
    const out = await decomposeJobQuery(RAW, buildDeps(db, provider, appUserId));
    expect(out.cached).toBe(false);
    expect(out.query_id).toBeTypeOf('string');

    const { data } = await db.from('job_queries').select('*').eq('id', out.query_id).single();
    expect(data).not.toBeNull();
    expect(data!.raw_text as string).toBe(RAW);
    expect(data!.model as string).toBe('stub-decomp-v1');
    expect(data!.prompt_version as string).toBe('stub-decomp-prompt-v1');
    expect(data!.normalized_text as string).toContain('Decompose-E2E-NodeJS');
    expect(data!.decomposed_json).toMatchObject({
      requirements: expect.any(Array),
      seniority: 'senior',
    });
    // Unresolved at this point (no matching catalog entry).
    expect((data!.unresolved_skills as string[]).sort()).toEqual(
      ['Decompose-E2E-NodeJS', 'Decompose-E2E-Uncataloged'].sort(),
    );
  });

  it('cache hit: a second call with a whitespace variant reuses the row', async () => {
    const provider = createStubDecompositionProvider({ fixture: fixtureResult() });
    const first = await decomposeJobQuery(RAW, buildDeps(db, provider, appUserId));

    // Swap double spaces / add a trailing newline — preprocess must
    // normalize these away so the hash still matches.
    const WHITESPACE_VARIANT = `   ${RAW.replace(/ /g, '  ')}   \n`;
    const second = await decomposeJobQuery(WHITESPACE_VARIANT, buildDeps(db, provider, appUserId));
    expect(second.cached).toBe(true);
    expect(second.query_id).toBe(first.query_id);

    const { count } = await db
      .from('job_queries')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', appUserId);
    expect(count).toBe(1);
  });

  it('catalog drift: updates resolved_json + unresolved_skills in place, leaves decomposed_json frozen', async () => {
    const provider = createStubDecompositionProvider({ fixture: fixtureResult() });
    const first = await decomposeJobQuery(RAW, buildDeps(db, provider, appUserId));
    const { data: before } = await db
      .from('job_queries')
      .select('decomposed_json, unresolved_skills')
      .eq('id', first.query_id)
      .single();
    const frozenDecomposed = before!.decomposed_json;

    // Add a matching skill to the catalog — normalized form of
    // 'Decompose-E2E-NodeJS' is 'decompose-e2e-nodejs'.
    const { data: skill, error } = await db
      .from('skills')
      .insert({ slug: TEST_SKILL_SLUG, canonical_name: 'Decompose E2E NodeJS' })
      .select('id')
      .single();
    if (error || !skill) throw new Error(error?.message ?? 'skill insert failed');
    seededSkillId = skill.id as string;

    const second = await decomposeJobQuery(RAW, buildDeps(db, provider, appUserId));
    expect(second.cached).toBe(true);
    expect(second.query_id).toBe(first.query_id);
    expect(second.unresolved_skills).toEqual(['Decompose-E2E-Uncataloged']);

    const { data: after } = await db
      .from('job_queries')
      .select('decomposed_json, unresolved_skills, resolved_json')
      .eq('id', first.query_id)
      .single();
    expect(after!.decomposed_json).toEqual(frozenDecomposed); // trigger held
    expect((after!.unresolved_skills as string[]).sort()).toEqual(['Decompose-E2E-Uncataloged']);
    // resolved_json carries the new skill_id for the resolved requirement.
    const resolved = after!.resolved_json as ResolvedDecomposition;
    const hit = resolved.requirements.find((r) => r.skill_raw === 'Decompose-E2E-NodeJS');
    expect(hit?.skill_id).toBe(seededSkillId);
  });
});
