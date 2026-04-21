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

export function buildRunMatchJobDeps(
  supabase: SupabaseClient,
  options: BuildRunMatchJobDepsOptions = {},
): RunMatchJobDeps {
  const ranker = new DeterministicRanker();

  async function fetchAllCandidateIds(_tenantId: string | null): Promise<string[]> {
    // RLS already scopes candidates; tenant_id hedge (ADR-003) is a
    // no-op in F1 and stays at the DB layer for Fase 2+.
    const { data, error } = await supabase.from('candidates').select('id');
    if (error) throw new Error(`fetchAllCandidateIds: ${error.message}`);
    return (data ?? []).map((r) => r.id as string);
  }

  async function fetchCandidatesWithAllSkills(
    skillIds: string[],
    _tenantId: string | null,
  ): Promise<string[]> {
    // We can't express the HAVING COUNT(DISTINCT) clause purely via
    // PostgREST filters, so we fetch the (candidate_id, skill_id)
    // pairs and intersect in-memory. For F1 scale (~100 candidates
    // × ~N resolved must-haves) this is well below the RLS join
    // cost of a dedicated RPC.
    const { data, error } = await supabase
      .from('experience_skills')
      .select('skill_id, candidate_experiences!inner(candidate_id)')
      .in('skill_id', skillIds);
    if (error) throw new Error(`fetchCandidatesWithAllSkills: ${error.message}`);

    const byCandidate = new Map<string, Set<string>>();
    for (const row of data ?? []) {
      const ce = row.candidate_experiences as unknown as { candidate_id: string } | null;
      if (ce === null) continue;
      const skillId = row.skill_id as string | null;
      if (skillId === null) continue;
      const set = byCandidate.get(ce.candidate_id) ?? new Set<string>();
      set.add(skillId);
      byCandidate.set(ce.candidate_id, set);
    }
    const out: string[] = [];
    for (const [candidateId, present] of byCandidate) {
      if (skillIds.every((s) => present.has(s))) out.push(candidateId);
    }
    return out;
  }

  async function loadExperiences(candidateIds: string[]): Promise<CandidateExperienceRow[]> {
    if (candidateIds.length === 0) return [];
    const { data, error } = await supabase
      .from('candidate_experiences')
      .select(
        'id, candidate_id, source_variant, kind, company, title, start_date, end_date, description, experience_skills(skill_id, skill_raw)',
      )
      .in('candidate_id', candidateIds);
    if (error) throw new Error(`loadExperiences: ${error.message}`);
    return (data ?? []).map((row) => ({
      candidate_id: row.candidate_id as string,
      id: row.id as string,
      source_variant: row.source_variant as SourceVariant,
      kind: row.kind as ExperienceKind,
      company: (row.company as string | null) ?? null,
      title: (row.title as string | null) ?? null,
      start_date: (row.start_date as string | null) ?? null,
      end_date: (row.end_date as string | null) ?? null,
      description: (row.description as string | null) ?? null,
      skills: ((row.experience_skills ?? []) as ExperienceSkill[]).map((s) => ({
        skill_id: s.skill_id ?? null,
        skill_raw: s.skill_raw,
      })),
    }));
  }

  async function loadLanguages(candidateIds: string[]): Promise<CandidateLanguageRow[]> {
    if (candidateIds.length === 0) return [];
    const { data, error } = await supabase
      .from('candidate_languages')
      .select('candidate_id, name, level')
      .in('candidate_id', candidateIds);
    if (error) throw new Error(`loadLanguages: ${error.message}`);
    return (data ?? []).map((r) => ({
      candidate_id: r.candidate_id as string,
      name: r.name as string,
      level: (r.level as string | null) ?? null,
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
        fetchCandidatesWithAllSkills,
        fetchAllCandidateIds,
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

      // Resolve skill_id → slug via skills_catalog (ADR-013).
      const allIds = Array.from(new Set(params.failed.flatMap((f) => f.missing_skill_ids)));
      if (allIds.length === 0) return { rescues_inserted: 0 };
      const { data: skills, error: skillErr } = await supabase
        .from('skills_catalog')
        .select('id, slug')
        .in('id', allIds);
      if (skillErr) throw new Error(`rescueFailedCandidates: skills_catalog: ${skillErr.message}`);
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
