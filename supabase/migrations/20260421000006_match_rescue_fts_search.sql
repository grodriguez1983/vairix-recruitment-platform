-- Migration: match_rescue_fts_search RPC — FTS over files.parsed_text
-- Depends on: 20260417205216_files (has idx_files_parsed_text GIN)
-- Ref: docs/adr/adr-016-complementary-signals.md §1
-- Rollback:
--   drop function if exists public.match_rescue_fts_search(uuid[], text[]);

-- ────────────────────────────────────────────────────────────────
-- Why
-- ────────────────────────────────────────────────────────────────
-- The recall-fallback bucket (ADR-016 §1) needs ts_rank + ts_headline
-- per (candidate, skill_slug). PostgREST can't express those scalars,
-- so we expose an RPC. `security invoker` keeps RLS applied to the
-- caller — recruiters already have read access to files.parsed_text
-- via "files_read_all_authenticated".
--
-- Shape: cross-join (candidate_ids × skill_slugs) against files,
-- filter by FTS match, return ts_rank + a short headline snippet.
-- The caller filters by `FTS_RESCUE_THRESHOLD` (0.1) in application
-- code — ADR-016 keeps the threshold there so it can be tuned
-- without a migration.

create or replace function public.match_rescue_fts_search(
  candidate_ids_in uuid[],
  skill_slugs_in text[]
)
returns table (
  candidate_id uuid,
  skill_slug text,
  ts_rank real,
  snippet text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    f.candidate_id,
    s.skill_slug,
    ts_rank(
      to_tsvector('simple', coalesce(f.parsed_text, '')),
      plainto_tsquery('simple', s.skill_slug)
    )::real as ts_rank,
    ts_headline(
      'simple',
      coalesce(f.parsed_text, ''),
      plainto_tsquery('simple', s.skill_slug),
      'MaxFragments=1,MaxWords=20,MinWords=5,StartSel=«,StopSel=»'
    ) as snippet
  from files f
  cross join unnest(skill_slugs_in) as s(skill_slug)
  where f.candidate_id = any(candidate_ids_in)
    and f.parsed_text is not null
    and f.deleted_at is null
    and to_tsvector('simple', coalesce(f.parsed_text, '')) @@ plainto_tsquery('simple', s.skill_slug);
$$;

comment on function public.match_rescue_fts_search(uuid[], text[]) is
  'ADR-016 §1 — FTS fallback for match_rescues. Returns ts_rank + headline per (candidate, skill_slug) pair. Caller filters by FTS_RESCUE_THRESHOLD.';
