-- Migration: job_queries (ADR-014 decomposition cache)
-- Depends on: 20260417205152_app_users (app_users + current_app_role)
-- Ref: docs/adr/adr-014-job-description-decomposition.md, docs/data-model.md §16.8, §17
-- Rollback:
--   drop trigger if exists trg_job_queries_immutable on job_queries;
--   drop function if exists enforce_job_queries_immutability();
--   drop table if exists job_queries;
--   drop function if exists public.current_app_user_id();

-- ────────────────────────────────────────────────────────────────
-- 1. Helper: current_app_user_id()
-- ────────────────────────────────────────────────────────────────
-- Mirror of public.current_app_role() (ADR-003 §5). Returns the
-- app_users.id for the authenticated caller. Used by RLS policies
-- that scope rows by ownership (this table is the first consumer;
-- match_runs.triggered_by in sub-block 4 will reuse it).
--
-- SECURITY DEFINER so the lookup works even when RLS on app_users
-- would hide the row (recruiter cannot read app_users directly).
create or replace function public.current_app_user_id()
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select id
  from app_users
  where auth_user_id = auth.uid()
    and deactivated_at is null
  limit 1
$$;

comment on function public.current_app_user_id() is
  'Returns app_users.id for the authenticated caller, or null. '
  'Used by RLS policies that scope rows by ownership (ADR-014, job_queries).';

revoke all on function public.current_app_user_id() from public;
grant execute on function public.current_app_user_id() to authenticated, anon;

-- ────────────────────────────────────────────────────────────────
-- 2. job_queries
-- ────────────────────────────────────────────────────────────────
-- Caches LLM decompositions of JDs. content_hash =
-- SHA256(normalized_text || NUL || prompt_version). decomposed_json
-- is the immutable LLM output; resolved_json is re-derived against
-- the current skills catalog without re-calling the LLM.
--
-- Design note on cross-user cache: RLS enforces "R/W own" per
-- data-model §17. If recruiter A decomposes hash X and recruiter B
-- later submits the same text, B cannot see A's cache row via the
-- user client and will re-pay the LLM call. For 5-15 internal
-- users the extra cost is marginal. Revisit in F4-006 (decompose
-- worker): options are (a) keep per-user cache, (b) tactical
-- service-role in the API route (violates CLAUDE.md 'no service
-- role in user-triggered routes'), or (c) async worker pattern.
create table job_queries (
  id                   uuid primary key default uuid_generate_v4(),
  tenant_id            uuid,
  created_by           uuid references app_users(id) on delete set null,
  raw_text             text,                            -- purgable (raw_text_retained=false)
  raw_text_retained    boolean not null default true,
  normalized_text      text not null,
  content_hash         text unique not null,
  model                text not null,
  prompt_version       text not null,
  decomposed_json      jsonb not null,                  -- IMMUTABLE post-insert (trigger)
  resolved_json        jsonb not null,                  -- mutable (re-resolve)
  unresolved_skills    text[] not null default '{}',
  resolved_at          timestamptz not null default now(),
  created_at           timestamptz not null default now()
);

create index idx_job_queries_created_by on job_queries(created_by);
create index idx_job_queries_tenant     on job_queries(tenant_id);
create index idx_job_queries_unresolved on job_queries using gin (unresolved_skills)
  where array_length(unresolved_skills, 1) > 0;

-- ────────────────────────────────────────────────────────────────
-- 3. Immutability trigger
-- ────────────────────────────────────────────────────────────────
-- Enforces the cache identity + audit chain at the DB level so even
-- service-role clients cannot silently rewrite a decomposition.
-- Frozen columns:
--   decomposed_json  — the LLM output (ADR-014 §3)
--   content_hash     — the cache key; rewriting it breaks idempotency
--   normalized_text  — the hash input; must match content_hash
--   model            — part of hash; rewriting breaks re-extraction policy
--   prompt_version   — idem
--   created_by       — ownership can't transfer silently (would bypass RLS)
-- Mutable columns explicitly allowed:
--   raw_text, raw_text_retained (purge policy)
--   resolved_json, unresolved_skills, resolved_at (re-resolve against catalog)
--   tenant_id (backfill hedge per ADR-003 multi-tenant strategy)
create or replace function enforce_job_queries_immutability()
returns trigger
language plpgsql
as $$
begin
  if new.decomposed_json is distinct from old.decomposed_json then
    raise exception 'job_queries.decomposed_json is immutable (ADR-014 §3)';
  end if;
  if new.content_hash is distinct from old.content_hash then
    raise exception 'job_queries.content_hash is immutable (cache identity)';
  end if;
  if new.normalized_text is distinct from old.normalized_text then
    raise exception 'job_queries.normalized_text is immutable (hash input)';
  end if;
  if new.model is distinct from old.model then
    raise exception 'job_queries.model is immutable (hash input)';
  end if;
  if new.prompt_version is distinct from old.prompt_version then
    raise exception 'job_queries.prompt_version is immutable (hash input)';
  end if;
  if new.created_by is distinct from old.created_by then
    raise exception 'job_queries.created_by is immutable (ownership lock)';
  end if;
  return new;
end;
$$;

create trigger trg_job_queries_immutable
  before update on job_queries
  for each row execute function enforce_job_queries_immutability();
