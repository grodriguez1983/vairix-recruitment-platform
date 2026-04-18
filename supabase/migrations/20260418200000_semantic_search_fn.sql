-- Migration: semantic_search_embeddings() RPC (F3-002)
-- Depends on: 20260417205218_embeddings (embeddings table + ivfflat index)
-- Ref: docs/adr/adr-005-embeddings-pipeline.md §Consumo, ADR-003 §5
-- Rollback: drop function if exists public.semantic_search_embeddings cascade;
--
-- Exposes a cosine-similarity lookup over the embeddings table as a
-- PostgREST RPC. Callers pass a query_embedding (float8[]) plus
-- optional filters; the function returns candidate_id + source_type +
-- score (in [0, 1], 1 = identical) ordered by proximity, capped by
-- max_results.
--
-- Security:
--   - `security invoker`: the function runs as the caller, so the
--     existing RLS policies on `embeddings` gate access. Recruiters
--     and admins can read; anonymous cannot.
--   - `stable`: declares the function pure-ish, enabling planner
--     optimizations (but still allowed to read tables).
--   - `set search_path = public, extensions`: per ADR-009, ensures
--     the `vector` type resolves regardless of the caller's path.
--
-- Input type choice:
--   The parameter is float8[] (not vector) because PostgREST's
--   JSON-to-typed-parameter coercion knows how to parse JSON arrays
--   of numbers but not pgvector's bespoke textual format. We cast
--   internally.
--
-- Score semantics:
--   `embedding <=> query` is cosine distance (0 = identical, 2 =
--   antipodal). We return `1 - distance` so higher is better, matching
--   the convention most callers expect from a "similarity" score.

create or replace function public.semantic_search_embeddings(
  query_embedding float8[],
  max_results int default 20,
  source_type_filter text[] default null
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
  order by e.embedding <=> query_embedding::vector
  limit max_results;
$$;

comment on function public.semantic_search_embeddings(float8[], int, text[]) is
  'Cosine-similarity lookup over embeddings. Returns (candidate_id, source_type, score) ordered by proximity. Score in [0,1], 1 = identical. RLS applies via security invoker. See ADR-005 §Consumo, F3-002.';
