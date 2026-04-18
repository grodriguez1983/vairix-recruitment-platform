-- Migration: 001 — extensions and helpers
-- Depends on: (none, first migration)
-- Ref: docs/data-model.md §Extensiones requeridas, §Trigger genérico de updated_at
-- Scope: install required Postgres extensions and define the generic
--        `set_updated_at()` trigger function used across all domain
--        tables. No domain tables created here — those come in 002+.
--
-- Rollback (manual, destructive — requires no dependent objects):
--   drop function if exists set_updated_at();
--   drop extension if exists "pg_trgm";
--   drop extension if exists "vector";
--   drop extension if exists "uuid-ossp";

-- 1. Extensions
create extension if not exists "uuid-ossp";
create extension if not exists "vector";
create extension if not exists "pg_trgm";

-- 1.1. Supabase hosted installs extensions into the `extensions`
-- schema, which is NOT in the default search_path of the `postgres`
-- role. Without this alter, `uuid_generate_v4()` (and any other
-- extension function) fails to resolve from migrations that follow.
-- We pin search_path to `public, extensions` at the database level so
-- every new connection — including the ones opened by subsequent
-- migrations — sees both schemas. Idempotent and safe to re-run.
-- See docs/adr/adr-009-supabase-hosted-search-path.md.
alter database postgres set search_path = public, extensions;

-- 2. Generic updated_at trigger function.
-- Used by every domain table via:
--   create trigger trg_<table>_updated_at
--     before update on <table>
--     for each row execute function set_updated_at();
create or replace function set_updated_at()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

comment on function set_updated_at() is
  'Generic trigger: sets updated_at = now() on row update. See docs/data-model.md.';
