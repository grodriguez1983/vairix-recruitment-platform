-- Migration: extend semantic_search_embeddings() with candidate_id_filter (F3-003)
-- Depends on: 20260418200000_semantic_search_fn
-- Ref: docs/use-cases.md §UC-01, docs/adr/adr-005-embeddings-pipeline.md §Consumo
-- Rollback: restore the 3-arg form from 20260418200000_semantic_search_fn.sql.
--
-- UC-01 (hybrid search) requires a two-step flow:
--   1) Structured filters on candidates/applications → candidate_ids[]
--   2) Vector similarity restricted to those ids.
--
-- Rather than issue two round-trips (one for ids, one for the RPC,
-- then join client-side), we push the id filter into the RPC so the
-- planner can prune the ivfflat scan to the intersection.
--
-- CREATE OR REPLACE cannot change a function's argument list, so we
-- drop the 3-arg form and create a 4-arg one. PostgREST callers that
-- omit `candidate_id_filter` still match because the parameter has a
-- `default null` clause.

drop function if exists public.semantic_search_embeddings(float8[], int, text[]);

create or replace function public.semantic_search_embeddings(
  query_embedding float8[],
  max_results int default 20,
  source_type_filter text[] default null,
  candidate_id_filter uuid[] default null
)
returns table (
  candidate_id uuid,
  source_type text,
  score double precision
)
language sql
stable
security invoker
set search_path = public, extensions
as $$
  select
    e.candidate_id,
    e.source_type,
    (1 - (e.embedding <=> query_embedding::vector))::double precision as score
  from embeddings e
  where e.embedding is not null
    and (source_type_filter is null or e.source_type = any(source_type_filter))
    and (candidate_id_filter is null or e.candidate_id = any(candidate_id_filter))
  order by e.embedding <=> query_embedding::vector
  limit max_results;
$$;

comment on function public.semantic_search_embeddings(float8[], int, text[], uuid[]) is
  'Cosine-similarity lookup over embeddings, optionally restricted to a candidate_id set (hybrid search). Returns (candidate_id, source_type, score) ordered by proximity. Score in [0,1]. RLS applies via security invoker. See ADR-005 §Consumo, UC-01, F3-003.';
