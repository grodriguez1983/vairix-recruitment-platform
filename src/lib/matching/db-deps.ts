/**
 * `buildRunMatchJobDeps` — wires `runMatchJob` deps against a
 * Supabase client (RLS-scoped per ADR-017). Used by the
 * POST /api/matching/run route.
 *
 * Intentionally thin: it only shapes rows; correctness lives in the
 * pure units (sub-A / sub-B / sub-C) and the DB (RLS + triggers).
 */
import type { SupabaseClient } from '@supabase/supabase-js';

import {
  fetchFtsRescues,
  type FtsHit,
  type FtsRescueCandidate,
} from '../rag/complementary-signals';
import type { ResolvedDecomposition } from '../rag/decomposition/resolve-requirements';

import type { CandidateExperienceRow, CandidateLanguageRow } from './load-candidate-aggregates';
import { loadCandidateAggregates } from './load-candidate-aggregates';
import { preFilterByMustHave } from './pre-filter';
import { DeterministicRanker } from './ranker';
import type { MatchResultRow, RunMatchJobDeps } from './run-match-job';
import type { ExperienceKind, ExperienceSkill, SourceVariant } from './types';

export interface BuildRunMatchJobDepsOptions {
  now?: () => Date;
}

/**
 * PostgREST hard-caps each SELECT response at `max_rows = 1000`
 * (supabase/config.toml). Any row-returning fetch MUST loop over
 * `.range(offset, offset + PAGE_SIZE - 1)` until a short page
 * signals EOF — otherwise rows past row 1000 are silently dropped.
 * Kept strictly below 1000 so "fewer rows than requested" is an
 * unambiguous EOF signal even under the cap.
 */
const PAGE_SIZE = 500;

/**
 * Cap for `.in('col', ids)` input arrays. Supabase-js renders these
 * as a comma-separated list in the querystring, which at ~50 chars
 * per UUID hits the server's URI length limit well before 1_000 ids
 * (observed "URI too long" at ~1_100 in the pagination RED test).
 * 200 keeps the encoded list under ~10KB, comfortably below the
 * default 8KB–16KB URI cap across the stack.
 */
const IN_CHUNK_SIZE = 200;

export function buildRunMatchJobDeps(
  supabase: SupabaseClient,
  options: BuildRunMatchJobDepsOptions = {},
): RunMatchJobDeps {
  const ranker = new DeterministicRanker();

  /**
   * Drive a range-paginated SELECT until a short page (< PAGE_SIZE)
   * signals EOF. `runPage(from, to)` is re-invoked per page so the
   * caller can rebuild any filters on the query — supabase-js
   * builders are not reusable once awaited.
   */
  async function paginateRange<T>(
    label: string,
    runPage: (
      from: number,
      to: number,
    ) => PromiseLike<{ data: T[] | null; error: { message: string } | null }>,
  ): Promise<T[]> {
    const out: T[] = [];
    let offset = 0;
    // Hard upper bound (5M rows) as a safety net against an infinite
    // loop if PostgREST ever returns a full page past end-of-data.
    const MAX_ITERATIONS = 10_000;
    for (let i = 0; i < MAX_ITERATIONS; i += 1) {
      const { data, error } = await runPage(offset, offset + PAGE_SIZE - 1);
      if (error) throw new Error(`${label}: ${error.message}`);
      const rows = data ?? [];
      for (const r of rows) out.push(r);
      if (rows.length < PAGE_SIZE) return out;
      offset += PAGE_SIZE;
    }
    throw new Error(`${label}: exceeded MAX_ITERATIONS paginating`);
  }

  async function fetchAllCandidateIds(_tenantId: string | null): Promise<string[]> {
    // RLS already scopes candidates; tenant_id hedge (ADR-003) is a
    // no-op in F1 and stays at the DB layer for Fase 2+.
    const rows = await paginateRange<{ id: string }>('fetchAllCandidateIds', (from, to) =>
      supabase.from('candidates').select('id').range(from, to),
    );
    return rows.map((r) => r.id);
  }

  async function fetchCandidateMustHaveCoverage(
    skillIds: string[],
    _tenantId: string | null,
  ): Promise<Array<{ candidate_id: string; covered_skill_ids: string[] }>> {
    // Fetch (candidate_id, skill_id) pairs for the resolved
    // must-have set and let the pure filter derive both included
    // (full coverage) and excluded (partial / zero coverage) in JS.
    // `skillIds` is typically tiny (≤ ~10 resolved must-haves) so we
    // chunk input defensively; the row count (one per experience
    // touching a must-have skill) can easily exceed max_rows on a
    // sizable candidate pool, so each chunk is range-paginated.
    if (skillIds.length === 0) return [];

    type Row = {
      skill_id: string | null;
      candidate_experiences: unknown;
    };
    const allRows: Row[] = [];
    for (let i = 0; i < skillIds.length; i += IN_CHUNK_SIZE) {
      const chunk = skillIds.slice(i, i + IN_CHUNK_SIZE);
      const rows = await paginateRange<Row>('fetchCandidateMustHaveCoverage', (from, to) =>
        supabase
          .from('experience_skills')
          .select('skill_id, candidate_experiences!inner(candidate_id)')
          .in('skill_id', chunk)
          .range(from, to),
      );
      for (const r of rows) allRows.push(r);
    }

    const byCandidate = new Map<string, Set<string>>();
    for (const row of allRows) {
      const ce = row.candidate_experiences as unknown as { candidate_id: string } | null;
      if (ce === null) continue;
      const skillId = row.skill_id;
      if (skillId === null) continue;
      const set = byCandidate.get(ce.candidate_id) ?? new Set<string>();
      set.add(skillId);
      byCandidate.set(ce.candidate_id, set);
    }
    const out: Array<{ candidate_id: string; covered_skill_ids: string[] }> = [];
    for (const [candidateId, present] of byCandidate) {
      out.push({ candidate_id: candidateId, covered_skill_ids: Array.from(present) });
    }
    return out;
  }

  async function loadExperiences(candidateIds: string[]): Promise<CandidateExperienceRow[]> {
    if (candidateIds.length === 0) return [];

    type Row = {
      id: string;
      candidate_id: string;
      source_variant: string;
      kind: string;
      company: string | null;
      title: string | null;
      start_date: string | null;
      end_date: string | null;
      description: string | null;
      experience_skills: Array<{ skill_id: string | null; skill_raw: string }> | null;
    };

    const all: Row[] = [];
    for (let i = 0; i < candidateIds.length; i += IN_CHUNK_SIZE) {
      const chunk = candidateIds.slice(i, i + IN_CHUNK_SIZE);
      const rows = await paginateRange<Row>('loadExperiences', (from, to) =>
        supabase
          .from('candidate_experiences')
          .select(
            'id, candidate_id, source_variant, kind, company, title, start_date, end_date, description, experience_skills(skill_id, skill_raw)',
          )
          .in('candidate_id', chunk)
          .range(from, to),
      );
      for (const r of rows) all.push(r);
    }

    return all.map((row) => ({
      candidate_id: row.candidate_id,
      id: row.id,
      source_variant: row.source_variant as SourceVariant,
      kind: row.kind as ExperienceKind,
      company: row.company ?? null,
      title: row.title ?? null,
      start_date: row.start_date ?? null,
      end_date: row.end_date ?? null,
      description: row.description ?? null,
      skills: ((row.experience_skills ?? []) as ExperienceSkill[]).map((s) => ({
        skill_id: s.skill_id ?? null,
        skill_raw: s.skill_raw,
      })),
    }));
  }

  async function loadLanguages(candidateIds: string[]): Promise<CandidateLanguageRow[]> {
    if (candidateIds.length === 0) return [];

    type Row = { candidate_id: string; name: string; level: string | null };
    const all: Row[] = [];
    for (let i = 0; i < candidateIds.length; i += IN_CHUNK_SIZE) {
      const chunk = candidateIds.slice(i, i + IN_CHUNK_SIZE);
      const rows = await paginateRange<Row>('loadLanguages', (from, to) =>
        supabase
          .from('candidate_languages')
          .select('candidate_id, name, level')
          .in('candidate_id', chunk)
          .range(from, to),
      );
      for (const r of rows) all.push(r);
    }

    return all.map((r) => ({
      candidate_id: r.candidate_id,
      name: r.name,
      level: r.level ?? null,
    }));
  }

  return {
    loadJobQuery: async (jobQueryId: string) => {
      const { data, error } = await supabase
        .from('job_queries')
        .select('id, resolved_json, resolved_at, tenant_id')
        .eq('id', jobQueryId)
        .maybeSingle();
      if (error) throw new Error(`loadJobQuery: ${error.message}`);
      if (data === null) return null;
      return {
        resolved: data.resolved_json as unknown as ResolvedDecomposition,
        catalog_snapshot_at: new Date(data.resolved_at as string),
        tenant_id: (data.tenant_id as string | null) ?? null,
      };
    },

    preFilter: async (jobQuery, tenantId) =>
      preFilterByMustHave(jobQuery, tenantId, {
        fetchAllCandidateIds,
        fetchCandidateMustHaveCoverage,
      }),

    loadCandidates: async (candidateIds) =>
      loadCandidateAggregates(candidateIds, { loadExperiences, loadLanguages }),

    rank: async (input) => ranker.rank(input),

    createMatchRun: async (params) => {
      const { data, error } = await supabase
        .from('match_runs')
        .insert({
          job_query_id: params.job_query_id,
          tenant_id: params.tenant_id,
          triggered_by: params.triggered_by,
          catalog_snapshot_at: params.catalog_snapshot_at.toISOString(),
          status: 'running',
        })
        .select('id')
        .single();
      if (error || !data) throw new Error(`createMatchRun: ${error?.message ?? 'no data'}`);
      return { id: data.id as string };
    },

    insertMatchResults: async (runId: string, rows: MatchResultRow[]) => {
      if (rows.length === 0) return;
      const { error } = await supabase.from('match_results').insert(
        rows.map((r) => ({
          match_run_id: runId,
          candidate_id: r.candidate_id,
          tenant_id: r.tenant_id,
          total_score: r.total_score,
          must_have_gate: r.must_have_gate,
          rank: r.rank,
          breakdown_json: r.breakdown_json as never,
        })),
      );
      if (error) throw new Error(`insertMatchResults: ${error.message}`);
    },

    completeMatchRun: async (runId, params) => {
      const { error } = await supabase
        .from('match_runs')
        .update({
          status: 'completed',
          finished_at: params.finished_at.toISOString(),
          candidates_evaluated: params.candidates_evaluated,
          diagnostics: params.diagnostics as never,
        })
        .eq('id', runId);
      if (error) throw new Error(`completeMatchRun: ${error.message}`);
    },

    failMatchRun: async (runId, params) => {
      const { error } = await supabase
        .from('match_runs')
        .update({
          status: 'failed',
          finished_at: params.finished_at.toISOString(),
          diagnostics: { reason: params.reason } as never,
        })
        .eq('id', runId);
      if (error) throw new Error(`failMatchRun: ${error.message}`);
    },

    rescueFailedCandidates: async (params) => {
      if (params.failed.length === 0) return { rescues_inserted: 0 };

      // Resolve skill_id → slug via the `skills` catalog table (ADR-013).
      const allIds = Array.from(new Set(params.failed.flatMap((f) => f.missing_skill_ids)));
      if (allIds.length === 0) return { rescues_inserted: 0 };
      const { data: skills, error: skillErr } = await supabase
        .from('skills')
        .select('id, slug')
        .in('id', allIds);
      if (skillErr) throw new Error(`rescueFailedCandidates: skills: ${skillErr.message}`);
      const idToSlug = new Map<string, string>();
      for (const s of skills ?? []) idToSlug.set(s.id as string, s.slug as string);

      const candidates: FtsRescueCandidate[] = params.failed.map((f) => ({
        candidate_id: f.candidate_id,
        missing_skill_slugs: f.missing_skill_ids
          .map((id) => idToSlug.get(id))
          .filter((s): s is string => typeof s === 'string'),
      }));

      // Inject the RPC-backed FTS query into the pure service.
      const rescues = await fetchFtsRescues(candidates, {
        queryFts: async ({ candidateIds, skillSlugs }) => {
          if (candidateIds.length === 0 || skillSlugs.length === 0) return [];
          const { data, error } = await supabase.rpc('match_rescue_fts_search', {
            candidate_ids_in: candidateIds,
            skill_slugs_in: skillSlugs,
          });
          if (error) throw new Error(`match_rescue_fts_search: ${error.message}`);
          const rows = (data ?? []) as Array<{
            candidate_id: string;
            skill_slug: string;
            ts_rank: number | string;
            snippet: string;
          }>;
          return rows.map(
            (r): FtsHit => ({
              candidate_id: r.candidate_id,
              skill_slug: r.skill_slug,
              ts_rank: Number(r.ts_rank),
              snippet: r.snippet,
            }),
          );
        },
      });

      if (rescues.length === 0) return { rescues_inserted: 0 };

      const { error: insertErr } = await supabase.from('match_rescues').insert(
        rescues.map((r) => ({
          match_run_id: params.run_id,
          candidate_id: r.candidate_id,
          tenant_id: params.tenant_id,
          missing_skills: r.missing_skills,
          fts_snippets: r.fts_snippets,
          fts_max_rank: r.fts_max_rank,
        })),
      );
      if (insertErr) throw new Error(`rescueFailedCandidates: insert: ${insertErr.message}`);
      return { rescues_inserted: rescues.length };
    },

    now: options.now,
  };
}
