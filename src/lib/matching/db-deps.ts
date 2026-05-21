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

import { buildMustHaveGroups } from './pre-filter';
import type {
  LoadedMatchRunForChunk,
  MatchRunStatus,
  ProcessMatchChunkDeps,
} from './process-match-chunk';
import { DeterministicRanker } from './ranker';
import type { MatchResultRow, RunMatchJobDeps } from './run-match-job';
import type { StartMatchRunDeps } from './start-match-run';
import type {
  CandidateAggregate,
  ExperienceInput,
  ExperienceKind,
  ExperienceSkill,
  SourceVariant,
} from './types';
import { mergeVariants } from './variant-merger';

export interface BuildRunMatchJobDepsOptions {
  now?: () => Date;
}

/**
 * Batch size for `insertMatchResults` (ADR-032). A single bulk
 * `.insert([...N rows])` of ~5_500 `match_results` rows blew past
 * Postgres `statement_timeout` (~27 s observed on the validation
 * run for `job_query c5cf4efe-…`). Each row carries a JSONB
 * `breakdown_json` of ~2 KB (requirement breakdowns + language +
 * seniority), so the request body for a full pool also hugs the
 * PostgREST ~1 MB body ceiling.
 *
 * Chunking to 500 rows per call:
 *   - keeps each request body well under the body cap (~1 MB);
 *   - keeps each Postgres statement under any reasonable
 *     `statement_timeout` (rough budget: ~5 ms/row inserts ×
 *     500 ≈ 2.5 s);
 *   - adds ~12 sequential round-trips for a 5_500-row pool, which
 *     at 30-60 ms RTT is ~500 ms of overhead — negligible vs the
 *     query cost.
 *
 * Sequential by design — writes contend for the same heap pages,
 * unique-index (`match_run_id, candidate_id`), and write-buffer.
 * Parallelizing would multiply lock contention without reducing
 * wall-clock (see ADR-032 §2).
 */
const INSERT_CHUNK_SIZE = 500;

export function buildRunMatchJobDeps(
  supabase: SupabaseClient,
  options: BuildRunMatchJobDepsOptions = {},
): RunMatchJobDeps {
  const ranker = new DeterministicRanker();

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

    // ADR-033 — Server-side pre-filter via the `match_pre_filter`
    // RPC. Replaces the previous chunked-IN fan-out across
    // `candidates` + `experience_skills`. The JS impl in
    // `pre-filter.ts` stays as the canonical reference (and is
    // covered by unit tests there); we reuse `buildMustHaveGroups`
    // to derive the exact same group shape and ship it to the RPC.
    preFilter: async (jobQuery, tenantId) => {
      const groups = buildMustHaveGroups(jobQuery);
      const totalAlts = groups.reduce((acc, g) => acc + g.skill_ids.length, 0);
      const t0 = Date.now();
      console.error(
        `[match] preFilter: start tenant=${tenantId ?? 'null'} groups=${groups.length} alts=${totalAlts}`,
      );
      const { data, error } = await supabase.rpc('match_pre_filter', {
        must_have_groups_in: groups as unknown as never,
        tenant_id_in: tenantId,
      });
      const elapsedMs = Date.now() - t0;
      if (error) {
        console.error(
          `[match] preFilter: FAILED after ${elapsedMs}ms code=${error.code ?? 'n/a'} message=${error.message}`,
        );
        throw new Error(`preFilter: ${error.message}`);
      }
      const payload = (data ?? {}) as {
        included?: string[];
        excluded?: Array<{ candidate_id: string; missing_must_have_skill_ids: string[] }>;
      };
      const includedCount = payload.included?.length ?? 0;
      const excludedCount = payload.excluded?.length ?? 0;
      console.error(
        `[match] preFilter: ok ${elapsedMs}ms included=${includedCount} excluded=${excludedCount}`,
      );
      return {
        included: payload.included ?? [],
        excluded: payload.excluded ?? [],
      };
    },

    // ADR-033 — Server-side aggregate loader via the
    // `match_load_aggregates` RPC. Replaces the previous chunked-IN
    // fan-out across `candidate_experiences` + `candidate_languages`.
    // `mergeVariants` (ADR-015) stays in TS — it's pure CPU work
    // operating on the per-candidate experiences array.
    loadCandidates: async (candidateIds) => {
      if (candidateIds.length === 0) return [];
      const t0 = Date.now();
      console.error(`[match] loadCandidates: start candidates=${candidateIds.length}`);
      const { data, error } = await supabase.rpc('match_load_aggregates', {
        candidate_ids_in: candidateIds,
        tenant_id_in: null,
      });
      const elapsedMs = Date.now() - t0;
      if (error) {
        console.error(
          `[match] loadCandidates: FAILED after ${elapsedMs}ms code=${error.code ?? 'n/a'} message=${error.message}`,
        );
        throw new Error(`loadCandidates: ${error.message}`);
      }
      const rowsLen = Array.isArray(data) ? data.length : 0;
      const bytes = JSON.stringify(data ?? []).length;
      console.error(`[match] loadCandidates: ok ${elapsedMs}ms rows=${rowsLen} bytes=${bytes}`);
      const rows = (data ?? []) as unknown as Array<{
        candidate_id: string;
        experiences: Array<{
          id: string;
          source_variant: string;
          kind: string;
          company: string | null;
          title: string | null;
          start_date: string | null;
          end_date: string | null;
          description: string | null;
          skills: Array<{ skill_id: string | null; skill_raw: string }>;
        }>;
        languages: Array<{ name: string; level: string | null }>;
      }>;

      const byId = new Map<string, (typeof rows)[number]>();
      for (const r of rows) byId.set(r.candidate_id, r);

      const out: CandidateAggregate[] = candidateIds.map((id) => {
        const row = byId.get(id);
        const exps: ExperienceInput[] = (row?.experiences ?? []).map((e) => ({
          id: e.id,
          source_variant: e.source_variant as SourceVariant,
          kind: e.kind as ExperienceKind,
          company: e.company,
          title: e.title,
          start_date: e.start_date,
          end_date: e.end_date,
          description: e.description,
          skills: (e.skills ?? []).map(
            (s): ExperienceSkill => ({ skill_id: s.skill_id, skill_raw: s.skill_raw }),
          ),
        }));
        const { experiences } = mergeVariants(exps);
        return {
          candidate_id: id,
          merged_experiences: experiences,
          languages: row?.languages ?? [],
        };
      });
      return out;
    },

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
      // ADR-032: chunk the bulk INSERT so each statement stays well
      // under Postgres `statement_timeout` and the request body
      // under the PostgREST ~1 MB cap. Sequential: writes contend
      // for the same pages/locks, so concurrency does not help here.
      // On chunk failure: throw immediately — already-inserted
      // chunks remain, but `failMatchRun` stamps the run and the
      // FK `ON DELETE CASCADE` lets a future GC clean orphans
      // (same partial-failure surface as the prior bulk impl).
      const t0 = Date.now();
      const totalChunks = Math.ceil(rows.length / INSERT_CHUNK_SIZE);
      console.error(`[match] insertMatchResults: start rows=${rows.length} chunks=${totalChunks}`);
      for (let i = 0; i < rows.length; i += INSERT_CHUNK_SIZE) {
        const chunk = rows.slice(i, i + INSERT_CHUNK_SIZE);
        const chunkIdx = Math.floor(i / INSERT_CHUNK_SIZE) + 1;
        const tc = Date.now();
        const { error } = await supabase.from('match_results').insert(
          chunk.map((r) => ({
            match_run_id: runId,
            candidate_id: r.candidate_id,
            tenant_id: r.tenant_id,
            total_score: r.total_score,
            must_have_gate: r.must_have_gate,
            rank: r.rank,
            breakdown_json: r.breakdown_json as never,
          })),
        );
        const chunkMs = Date.now() - tc;
        if (error) {
          console.error(
            `[match] insertMatchResults: FAILED chunk ${chunkIdx}/${totalChunks} after ${chunkMs}ms code=${error.code ?? 'n/a'} message=${error.message}`,
          );
          throw new Error(`insertMatchResults: ${error.message}`);
        }
        console.error(
          `[match] insertMatchResults: chunk ${chunkIdx}/${totalChunks} ok ${chunkMs}ms`,
        );
      }
      console.error(`[match] insertMatchResults: done total ${Date.now() - t0}ms`);
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

/**
 * `buildProcessMatchChunkDeps` — wires `processMatchChunk` (ADR-034 §2)
 * deps against an RLS-scoped Supabase client.
 *
 * - `loadRunForChunk` does two reads (match_runs + job_queries). A
 *   JOIN via PostgREST embedded resources would also work but requires
 *   the FK to be exposed; two round-trips are sub-millisecond against
 *   primary keys and keep the adapter simple.
 * - `loadCandidates` and `rank` are reused from the legacy builder
 *   (same RPC + ranker, same shapes).
 * - `insertMatchResults` is reused — already chunked (ADR-032). With
 *   a /process-chunk batch of ≤500 rows it issues a single insert.
 * - `bumpProgress` is a read-then-write at the JS layer. ADR-034 has
 *   a single FE driving the loop sequentially, so the race window is
 *   not exercised. If we ever parallelize chunks, swap this for an
 *   RPC that does `UPDATE ... SET processed_count = processed_count
 *   + $delta ... RETURNING processed_count` atomically.
 */
export function buildProcessMatchChunkDeps(
  supabase: SupabaseClient,
  options: BuildRunMatchJobDepsOptions = {},
): ProcessMatchChunkDeps {
  const full = buildRunMatchJobDeps(supabase, options);
  const now = options.now ?? ((): Date => new Date());

  return {
    loadRunForChunk: async (runId: string): Promise<LoadedMatchRunForChunk | null> => {
      const { data: run, error: runErr } = await supabase
        .from('match_runs')
        .select('id, status, expected_count, processed_count, tenant_id, job_query_id')
        .eq('id', runId)
        .maybeSingle();
      if (runErr) throw new Error(`loadRunForChunk: ${runErr.message}`);
      if (run === null) return null;

      const { data: jq, error: jqErr } = await supabase
        .from('job_queries')
        .select('resolved_json, resolved_at')
        .eq('id', run.job_query_id as string)
        .maybeSingle();
      if (jqErr) throw new Error(`loadRunForChunk: job_query: ${jqErr.message}`);
      if (jq === null) {
        throw new Error(
          `loadRunForChunk: job_query ${run.job_query_id} not found for run ${runId}`,
        );
      }

      return {
        status: run.status as MatchRunStatus,
        expected_count: (run.expected_count as number | null) ?? null,
        processed_count: (run.processed_count as number | null) ?? 0,
        tenant_id: (run.tenant_id as string | null) ?? null,
        job_query_id: run.job_query_id as string,
        resolved: jq.resolved_json as unknown as ResolvedDecomposition,
        catalog_snapshot_at: new Date(jq.resolved_at as string),
      };
    },

    loadCandidates: full.loadCandidates,
    rank: full.rank,
    insertMatchResults: full.insertMatchResults,

    bumpProgress: async (runId: string, delta: number) => {
      // Read-then-write. See module-level comment for the
      // concurrency assumption (single-FE sequential loop).
      const { data: current, error: readErr } = await supabase
        .from('match_runs')
        .select('processed_count')
        .eq('id', runId)
        .single();
      if (readErr) throw new Error(`bumpProgress: read: ${readErr.message}`);
      const newCount = (current.processed_count as number) + delta;
      const { error: writeErr } = await supabase
        .from('match_runs')
        .update({
          processed_count: newCount,
          last_progress_at: now().toISOString(),
        })
        .eq('id', runId);
      if (writeErr) throw new Error(`bumpProgress: write: ${writeErr.message}`);
      return { processed_count: newCount };
    },

    now,
  };
}

/**
 * `buildStartMatchRunDeps` — wires `startMatchRun` (ADR-034 §1) deps
 * against an RLS-scoped Supabase client. Reuses `loadJobQuery`,
 * `preFilter`, `createMatchRun` and `failMatchRun` from the legacy
 * builder (same shapes, same RLS posture) and adds `setExpectedCount`,
 * which stamps `match_runs.expected_count` from the preFilter result.
 */
export function buildStartMatchRunDeps(
  supabase: SupabaseClient,
  options: BuildRunMatchJobDepsOptions = {},
): StartMatchRunDeps {
  const full = buildRunMatchJobDeps(supabase, options);
  return {
    loadJobQuery: full.loadJobQuery,
    createMatchRun: full.createMatchRun,
    preFilter: full.preFilter,
    failMatchRun: full.failMatchRun,
    setExpectedCount: async (runId, expectedCount) => {
      const { error } = await supabase
        .from('match_runs')
        .update({ expected_count: expectedCount })
        .eq('id', runId);
      if (error) throw new Error(`setExpectedCount: ${error.message}`);
    },
    now: options.now ?? (() => new Date()),
  };
}
