-- Migration: 003 — candidates table
-- Depends on: 001 (extensions, set_updated_at)
-- Ref: docs/data-model.md §2
-- Scope: mirror of Teamtailor candidates. Soft-deletable, indexed for
--        name search (pg_trgm) and common filters.
--
-- Rollback: drop table if exists candidates cascade;

create table candidates (
  id             uuid primary key default uuid_generate_v4(),
  tenant_id      uuid,
  teamtailor_id  text unique not null,
  first_name     text,
  last_name      text,
  email          text,
  phone          text,
  linkedin_url   text,
  pitch          text,
  sourced        boolean default false,
  raw_data       jsonb,
  deleted_at     timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  synced_at      timestamptz not null default now()
);

create index idx_candidates_teamtailor_id on candidates(teamtailor_id);
create index idx_candidates_email         on candidates(email);
create index idx_candidates_updated_at    on candidates(updated_at desc);
create index idx_candidates_deleted_at    on candidates(deleted_at)
  where deleted_at is null;
create index idx_candidates_tenant        on candidates(tenant_id);
create index idx_candidates_name_trgm on candidates
  using gin ((coalesce(first_name, '') || ' ' || coalesce(last_name, ''))
             gin_trgm_ops);

create trigger trg_candidates_updated_at
  before update on candidates
  for each row execute function set_updated_at();
